import { pauseActiveTime, interruptCalls } from './execution-control.js';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { OperationBodies, Session, TaskDetail } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { activeAttempt } from './execution-model.js';
import { invalidateApproval, lockEditorialTeam } from './editorial-state.js';
import { rejectUnsentPublication } from './publication-preflight.js';
import {
  auditEvents,
  executionAttempts,
  executionSteps,
  idempotencyRecords,
  members,
  publicationDispatches,
  publicationOperations,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Actor = Session['member'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskTerminationService {
  constructor(
    private db: Database,
    private read: (
      connection: Database | Transaction,
      taskId: string,
      actor: Actor,
    ) => Promise<TaskDetail>,
    private now: () => Date,
  ) {}
  async terminate(input: {
    taskId: string;
    actor: Actor;
    body: OperationBodies['terminateTask'];
    key: string;
    requestId: string;
  }): Promise<{ data: TaskDetail; replayed: boolean }> {
    const { actor, body } = input;
    if (!uuid.test(input.taskId)) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
    const taskId = input.taskId.toLowerCase(),
      reason = body.reason.trim();
    if (!reason || reason.length > 2000)
      throw new AuthError(400, 'VALIDATION_ERROR', '请填写不超过 2000 字的终止原因。');
    const scopeHash = hash([actor.teamId, actor.id, 'terminateTask', taskId]),
      keyHash = hash(input.key);
    const fingerprint = hash([body.expectedRevision, reason]);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${Buffer.from(hash([scopeHash, keyHash]), 'hex')
            .readBigInt64BE()
            .toString()}::bigint)`,
        );
        await lockEditorialTeam(tx, actor.teamId);
        const [member] = await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.id, actor.id),
              eq(members.teamId, actor.teamId),
              eq(members.role, actor.role),
              eq(members.version, actor.version),
              eq(members.status, 'active'),
            ),
          )
          .for('share');
        if (!member || !['admin', 'operator'].includes(member.role))
          throw new AuthError(403, 'FORBIDDEN', '成员身份已变化，请重新登录。');
        const [task] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.teamId, actor.teamId)))
          .for('update');
        if (!task) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
        const now = this.now();
        const [cached] = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.scopeHash, scopeHash),
              eq(idempotencyRecords.keyHash, keyHash),
            ),
          );
        if (cached && cached.expiresAt > now && cached.requestFingerprint !== fingerprint)
          throw new AuthError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            '同一动作标识不能提交不同的终止请求。',
          );
        const finish = async (replayed: boolean) => {
          const data = await this.read(tx, taskId, actor);
          if (!(cached && cached.expiresAt > now)) {
            if (cached)
              await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, cached.id));
            await tx.insert(idempotencyRecords).values({
              scopeHash,
              keyHash,
              requestFingerprint: fingerprint,
              status: 'completed',
              responseStatus: 202,
              responseBody: data,
              createdAt: now,
              expiresAt: new Date(now.getTime() + 86400000),
            });
          }
          return { data, replayed };
        };
        // The terminal business fact remains idempotent beyond the HTTP key lifetime.
        if (task.lifecycle === 'terminated') return finish(true);
        if (task.lifecycle !== 'open' || task.publishedOperationId)
          throw new AuthError(409, 'INVALID_STATE', '已发布任务不能终止；终止不会撤回已发内容。');
        if (task.revision !== body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务状态已变化，请刷新核对后重新确认终止。',
          );
        if (task.activePublishOperationId) {
          const [operation] = await tx
            .select()
            .from(publicationOperations)
            .where(
              and(
                eq(publicationOperations.id, task.activePublishOperationId),
                eq(publicationOperations.taskId, taskId),
              ),
            )
            .for('update');
          const [dispatch] = operation
            ? await tx
                .select()
                .from(publicationDispatches)
                .where(
                  and(
                    eq(publicationDispatches.operationId, operation.id),
                    eq(publicationDispatches.id, operation.currentDispatchId),
                  ),
                )
                .for('update')
            : [];
          if (
            !operation ||
            !dispatch ||
            !(await rejectUnsentPublication(tx, {
              task,
              operation,
              dispatch,
              failure: {
                code: 'PUBLICATION_CANCELLED',
                message: '未发送：任务已由用户终止。',
                retryable: false,
              },
              actor,
              now,
              releaseTask: false,
            }))
          )
            throw new AuthError(
              423,
              'PUBLICATION_LOCKED',
              '已有人工交接或可能已发送的操作，请先完成回填或核实，不能直接终止解锁。',
            );
        }
        const [attempt] = task.currentAttemptId
          ? await tx
              .select()
              .from(executionAttempts)
              .where(
                and(
                  eq(executionAttempts.id, task.currentAttemptId),
                  eq(executionAttempts.taskId, taskId),
                ),
              )
              .for('update')
          : [];
        const stopping = !!attempt && activeAttempt(attempt.status);
        if (stopping) {
          await pauseActiveTime(tx, attempt, now);
          await interruptCalls(tx, attempt.id, now, null);
          await tx
            .update(executionAttempts)
            .set({
              status: 'cancelled',
              currentStep: '任务已终止',
              cancelScope: 'terminate_task',
              cancelRequestedAt: now,
              cancelRequestedBy: actor.id,
              cancelReason: reason,
              stoppedAt: now,
              finishedAt: now,
              nextRunAt: null,
            })
            .where(eq(executionAttempts.id, attempt.id));
          await tx
            .update(executionSteps)
            .set({
              status: 'cancelled',
              finishedAt: now,
              durationMs: sql`CASE WHEN ${executionSteps.startedAt} IS NULL THEN NULL ELSE greatest(0, least(2147483647, floor(extract(epoch FROM (${now}::timestamptz - ${executionSteps.startedAt})) * 1000)))::integer END`,
            })
            .where(
              and(
                eq(executionSteps.attemptId, attempt.id),
                inArray(executionSteps.status, ['queued', 'running']),
              ),
            );
        }
        await invalidateApproval(tx, task, now, `任务已终止：${reason}`);
        await tx
          .update(tasks)
          .set({
            lifecycle: 'terminated',
            terminatedBy: actor.id,
            terminatedAt: now,
            terminationReason: reason,
            activePublishOperationId: null,
            approvalStatus: task.currentApprovalId ? 'invalidated' : task.approvalStatus,
            ...(stopping
              ? { executionStatus: 'cancelled' as const, workGeneration: task.workGeneration + 1 }
              : {}),
            currentStep: '任务已终止',
            revision: task.revision + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, taskId));
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action: 'task.terminated',
          targetType: 'task',
          targetId: taskId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          outcome: 'succeeded',
          reason,
          requestId: input.requestId,
          createdAt: now,
        });
        return finish(false);
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '终止结果尚未确认，请先查询任务，再使用原动作标识确认。',
      );
    }
  }
}
