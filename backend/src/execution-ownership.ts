import { pauseActiveTime, interruptCalls } from './execution-control.js';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { createBusinessDatabase } from './database.js';
import {
  auditEvents,
  executionAttempts,
  executionSteps,
  publicationDispatches,
  publicationOperations,
  publicationSendClaims,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
export type ExecutionTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type ExecutionConnection = Database | ExecutionTransaction;

/** Production lease decisions use the database clock across all worker processes. */
export async function executionNow(connection: ExecutionConnection, override?: () => Date) {
  if (override) return override();
  const result = await connection.execute<{ now: Date | string }>(
    sql`SELECT clock_timestamp() AS now`,
  );
  return new Date(result.rows[0]!.now);
}

/** Reaping fences the old generation before making the task available to a person.
 * Expired running attempts are never put back on the queue. */
export async function recoverInterruptedExecutions(db: Database, clock?: () => Date) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const now = await executionNow(tx, clock);
    const jobs = await tx
      .select({ task: tasks, attempt: executionAttempts })
      .from(tasks)
      .innerJoin(executionAttempts, eq(executionAttempts.taskId, tasks.id))
      .where(
        and(
          eq(executionAttempts.status, 'running'),
          or(isNull(executionAttempts.leaseExpiresAt), lte(executionAttempts.leaseExpiresAt, now)),
        ),
      )
      .limit(20)
      .for('update', { of: [tasks, executionAttempts], skipLocked: true });
    for (const { task, attempt } of jobs) {
      const cancelled = !!attempt.cancelRequestedAt;
      const status = cancelled ? ('cancelled' as const) : ('failed' as const);
      const error = cancelled
        ? null
        : {
            code: 'EXECUTION_INTERRUPTED',
            message: '执行器租约已失效或旧执行进程已中断，请人工重新执行。',
            retryable: true,
          };
      await pauseActiveTime(tx, attempt, now);
      await interruptCalls(tx, attempt.id, now, error);
      await tx
        .update(executionSteps)
        .set({
          status: cancelled ? 'cancelled' : 'failed',
          finishedAt: now,
          durationMs: sql`greatest(0, least(2147483647, floor(extract(epoch FROM (${now}::timestamptz - ${executionSteps.startedAt})) * 1000)))::integer`,
          error,
        })
        .where(and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'running')));
      await tx
        .update(executionSteps)
        .set({ status: 'cancelled', finishedAt: now })
        .where(and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'queued')));
      const currentStep = cancelled ? '已停止' : '执行中断';
      await tx
        .update(executionAttempts)
        .set({
          status,
          currentStep,
          error,
          finishedAt: now,
          stoppedAt: cancelled ? now : null,
          nextRunAt: null,
        })
        .where(eq(executionAttempts.id, attempt.id));
      const current =
        task.currentAttemptId === attempt.id && task.workGeneration === attempt.generation;
      if (current)
        await tx
          .update(tasks)
          .set({
            executionStatus: status,
            currentStep,
            errorMessage: error?.message ?? null,
            workGeneration: task.workGeneration + 1,
            revision: task.revision + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id));
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'system',
        actorId: 'execution-recovery',
        action: 'attempt.interrupted',
        targetType: 'execution_attempt',
        targetId: attempt.id,
        beforeRevision: task.revision,
        afterRevision: task.revision + (current ? 1 : 0),
        outcome: cancelled ? 'succeeded' : 'failed',
        reason: error?.message ?? attempt.cancelReason,
        requestId: `interrupted:${attempt.id}:${attempt.claimToken ?? 'legacy'}`,
        createdAt: now,
      });
    }
    return jobs.length;
  });
}

/** A send ticket is immutable. Its deadline outlives the sender's own timeout.
 * Recovery only records uncertainty and retains the lock; it never calls a sender. */
export async function recoverInterruptedPublications(
  db: Database,
  leaseMs: number,
  clock?: () => Date,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const now = await executionNow(tx, clock);
    const jobs = await tx
      .select({
        task: tasks,
        operation: publicationOperations,
        dispatch: publicationDispatches,
        claim: publicationSendClaims,
      })
      .from(tasks)
      .innerJoin(
        publicationOperations,
        eq(publicationOperations.id, tasks.activePublishOperationId),
      )
      .innerJoin(
        publicationDispatches,
        eq(publicationDispatches.id, publicationOperations.currentDispatchId),
      )
      .leftJoin(
        publicationSendClaims,
        eq(publicationSendClaims.dispatchId, publicationDispatches.id),
      )
      .where(
        and(
          eq(publicationOperations.status, 'publishing'),
          eq(publicationDispatches.status, 'publishing'),
          inArray(publicationDispatches.channel, ['simulation', 'official_api']),
          or(
            lte(publicationSendClaims.expiresAt, now),
            and(
              isNull(publicationSendClaims.dispatchId),
              lte(publicationDispatches.startedAt, new Date(now.getTime() - leaseMs)),
            ),
            and(
              isNull(publicationSendClaims.expiresAt),
              lte(publicationSendClaims.claimedAt, new Date(now.getTime() - 330_000)),
            ),
          ),
        ),
      )
      .limit(20)
      .for('update', {
        of: [tasks, publicationOperations, publicationDispatches],
        skipLocked: true,
      });
    let recovered = 0;
    for (const { task, operation, dispatch } of jobs) {
      // A sender can insert its ticket without updating the task row. The outer
      // join's earlier snapshot may therefore be stale even after we obtain the
      // task lock. Re-read admission under that lock before declaring "not sent".
      const [claim] = await tx
        .select()
        .from(publicationSendClaims)
        .where(eq(publicationSendClaims.dispatchId, dispatch.id));
      const deadline = claim
        ? (claim.expiresAt ?? new Date(claim.claimedAt.getTime() + 330_000))
        : new Date(dispatch.startedAt.getTime() + leaseMs);
      if (deadline > now) continue;
      const status = claim ? ('verification_required' as const) : ('failed' as const);
      const error = claim
        ? {
            code: 'PUBLICATION_INTERRUPTED',
            message: '发送期限已过，结果待核实；禁止自动再次发送。',
            retryable: false,
          }
        : {
            code: 'PUBLICATION_NOT_SENT',
            message: '发送前执行中断，未取得发送占用，未发送。',
            retryable: false,
          };
      await tx
        .update(publicationDispatches)
        .set({ status, error, finishedAt: claim ? null : now })
        .where(eq(publicationDispatches.id, dispatch.id));
      await tx
        .update(publicationOperations)
        .set({ status, updatedAt: now })
        .where(eq(publicationOperations.id, operation.id));
      await tx
        .update(tasks)
        .set({
          revision: task.revision + 1,
          updatedAt: now,
          ...(!claim ? { activePublishOperationId: null } : {}),
        })
        .where(eq(tasks.id, task.id));
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'system',
        actorId: 'publication-recovery',
        action: 'publication.interrupted',
        targetType: 'publication',
        targetId: operation.id,
        beforeRevision: task.revision,
        afterRevision: task.revision + 1,
        outcome: 'failed',
        reason: error.message,
        requestId: `interrupted:${dispatch.id}`,
        createdAt: now,
      });
      recovered++;
    }
    return recovered;
  });
}
