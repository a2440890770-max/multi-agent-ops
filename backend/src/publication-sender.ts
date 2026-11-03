import { and, eq, sql } from 'drizzle-orm';
import type { PublicationSnapshot, Session, TaskDetail } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { lockEditorialTeam } from './editorial-state.js';
import { publicationPreflight, rejectUnsentPublication } from './publication-preflight.js';
import {
  auditEvents,
  members,
  publicationDispatches,
  publicationOperations,
  publicationSendClaims,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Actor = Session['member'];
type ReadTask = (
  connection: Database | Transaction,
  taskId: string,
  actor: Actor,
) => Promise<TaskDetail>;
type Identity = { taskId: string; operationId: string; actor: Actor };
export type PublicationSendInput = {
  operationId: string;
  dispatchId: string;
  /** Use this identity for a provider's idempotency key, if supported. */
  idempotencyKey: string;
  snapshot: PublicationSnapshot;
};
export type PublicationSendResult =
  | { outcome: 'published'; platformPostId: string; url: string }
  | { outcome: 'failed'; code: string; message: string }
  | { outcome: 'unknown' };

/** Only explicitly injected by tests. No implementation is wired into server.ts. */
export interface SimulationPublicationAdapter {
  readonly mode: 'simulation';
  readonly timeoutMs: number;
  send(input: PublicationSendInput): Promise<PublicationSendResult>;
}

/** Admission commits before I/O. Neither HTTP replay nor recovery ever invokes send. */
export class PublicationSender {
  constructor(
    private db: Database,
    private read: ReadTask,
    private now: () => Date,
    private adapter: SimulationPublicationAdapter,
  ) {
    if (
      adapter.mode !== 'simulation' ||
      !Number.isInteger(adapter.timeoutMs) ||
      adapter.timeoutMs < 1 ||
      adapter.timeoutMs > 300_000
    )
      throw new Error('Invalid test publication adapter');
  }

  private async locked(tx: Transaction, input: Identity) {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
    await lockEditorialTeam(tx, input.actor.teamId);
    const [member] = await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.id, input.actor.id),
          eq(members.teamId, input.actor.teamId),
          eq(members.version, input.actor.version),
          eq(members.role, input.actor.role),
          eq(members.status, 'active'),
        ),
      )
      .for('share');
    if (!member || !['admin', 'operator'].includes(member.role))
      throw new AuthError(403, 'FORBIDDEN', '成员身份已变化，请重新登录。');
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.teamId, input.actor.teamId)))
      .for('update');
    if (!task) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
    const [operation] = await tx
      .select()
      .from(publicationOperations)
      .where(
        and(
          eq(publicationOperations.id, input.operationId),
          eq(publicationOperations.taskId, task.id),
        ),
      )
      .for('update');
    if (!operation) throw new AuthError(404, 'NOT_FOUND', '发布操作不存在。');
    const [dispatch] = await tx
      .select()
      .from(publicationDispatches)
      .where(
        and(
          eq(publicationDispatches.id, operation.currentDispatchId),
          eq(publicationDispatches.operationId, operation.id),
        ),
      )
      .for('update');
    if (!dispatch || dispatch.channel !== 'simulation')
      throw new AuthError(409, 'INVALID_STATE', '仅支持测试模拟发送。');
    return { task, operation, dispatch };
  }

  async send(input: Identity & { dispatchId: string }) {
    const admitted = await this.db.transaction(async (tx) => {
      const { task, operation, dispatch } = await this.locked(tx, input);
      if (
        dispatch.id !== input.dispatchId ||
        operation.status !== 'publishing' ||
        dispatch.status !== 'publishing'
      )
        return null;
      if (task.activePublishOperationId !== operation.id) return null;
      const [existingClaim] = await tx
        .select()
        .from(publicationSendClaims)
        .where(eq(publicationSendClaims.dispatchId, dispatch.id));
      if (existingClaim) return null;
      const detail = await this.read(tx, task.id, input.actor);
      const failure = await publicationPreflight(tx, detail, operation);
      if (failure) {
        await rejectUnsentPublication(tx, {
          task,
          operation,
          dispatch,
          failure,
          actor: input.actor,
          now: this.now(),
        });
        return null;
      }
      const claims = await tx
        .insert(publicationSendClaims)
        .values({
          dispatchId: dispatch.id,
          operationId: operation.id,
          claimedAt: this.now(),
          expiresAt: new Date(this.now().getTime() + this.adapter.timeoutMs + 30_000),
        })
        .onConflictDoNothing()
        .returning();
      if (!claims.length) return null;
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'member',
        actorId: input.actor.id,
        action: 'publication.send_claimed',
        targetType: 'publication',
        targetId: operation.id,
        outcome: 'succeeded',
        requestId: `send:${dispatch.id}`,
        createdAt: this.now(),
      });
      return {
        operationId: operation.id,
        dispatchId: dispatch.id,
        idempotencyKey: dispatch.id,
        snapshot: operation.snapshot,
      };
    });
    if (!admitted) return;

    let result: PublicationSendResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // No network call is held inside a database transaction. Any throw or timeout
      // means "possibly sent"; there is deliberately no retry loop here.
      result = await Promise.race([
        this.adapter.send(admitted),
        new Promise<PublicationSendResult>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: 'unknown' }), this.adapter.timeoutMs);
        }),
      ]);
    } catch {
      result = { outcome: 'unknown' };
    } finally {
      if (timer) clearTimeout(timer);
    }
    await this.complete(input, result);
  }

  private async complete(input: Identity & { dispatchId: string }, result: PublicationSendResult) {
    await this.db.transaction(async (tx) => {
      const { task, operation, dispatch } = await this.locked(tx, input);
      // A recovery or human conclusion fences late receipts from an older send.
      if (
        dispatch.id !== input.dispatchId ||
        operation.status !== 'publishing' ||
        dispatch.status !== 'publishing' ||
        task.activePublishOperationId !== operation.id
      )
        return;
      const published =
        result?.outcome === 'published' && !!result.platformPostId?.trim() && !!result.url?.trim();
      const failed = result?.outcome === 'failed';
      const status = published ? 'published' : failed ? 'failed' : 'verification_required';
      const now = this.now();
      await tx
        .update(publicationDispatches)
        .set({
          status,
          finishedAt: status === 'verification_required' ? null : now,
          platformPostId: published ? result.platformPostId : null,
          url: published ? result.url : null,
          error: published
            ? null
            : {
                code: failed ? result.code : 'PUBLICATION_RESULT_UNKNOWN',
                message: failed ? result.message : '发送结果未知，请人工核实；禁止自动再次发送。',
                retryable: false,
              },
        })
        .where(eq(publicationDispatches.id, dispatch.id));
      await tx
        .update(publicationOperations)
        .set({ status, updatedAt: now })
        .where(eq(publicationOperations.id, operation.id));
      await tx
        .update(tasks)
        .set({
          lifecycle: published ? 'published' : task.lifecycle,
          activePublishOperationId: status === 'verification_required' ? operation.id : null,
          publishedOperationId: published ? operation.id : task.publishedOperationId,
          revision: task.revision + 1,
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'system',
        actorId: 'simulation-adapter',
        action: `publication.simulation_${status}`,
        targetType: 'publication',
        targetId: operation.id,
        beforeRevision: task.revision,
        afterRevision: task.revision + 1,
        outcome: published ? 'succeeded' : 'failed',
        requestId: `result:${dispatch.id}`,
        createdAt: now,
      });
    });
  }

  /** Call only after the test sender process is known to have stopped. Never sends. */
  async recover(input: Identity) {
    await this.db.transaction(async (tx) => {
      const { task, operation, dispatch } = await this.locked(tx, input);
      if (
        operation.status !== 'publishing' ||
        dispatch.status !== 'publishing' ||
        task.activePublishOperationId !== operation.id
      )
        return;
      const now = this.now();
      await tx
        .update(publicationDispatches)
        .set({
          status: 'verification_required',
          error: {
            code: 'PUBLICATION_INTERRUPTED',
            message: '发送进程已退出，结果待核实；禁止自动再次发送。',
            retryable: false,
          },
        })
        .where(eq(publicationDispatches.id, dispatch.id));
      await tx
        .update(publicationOperations)
        .set({ status: 'verification_required', updatedAt: now })
        .where(eq(publicationOperations.id, operation.id));
      await tx
        .update(tasks)
        .set({ revision: task.revision + 1, updatedAt: now })
        .where(eq(tasks.id, task.id));
      await tx.insert(auditEvents).values({
        teamId: task.teamId,
        taskId: task.id,
        actorType: 'system',
        actorId: 'simulation-recovery',
        action: 'publication.simulation_recovered',
        targetType: 'publication',
        targetId: operation.id,
        beforeRevision: task.revision,
        afterRevision: task.revision + 1,
        outcome: 'failed',
        requestId: `recover:${dispatch.id}`,
        createdAt: now,
      });
    });
    return this.read(this.db, input.taskId, input.actor);
  }
}
