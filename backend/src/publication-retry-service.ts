import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { OperationBodies, ResponseModels, Session, TaskDetail } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { lockEditorialTeam } from './editorial-state.js';
import { publicationModel } from './publication-model.js';
import {
  auditEvents,
  idempotencyRecords,
  members,
  publicationDispatches,
  publicationOperations,
  publicationVerifications,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
type Actor = Session['member'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class PublicationRetryService {
  constructor(
    private db: Database,
    private read: (connection: Connection, id: string, actor: Actor) => Promise<TaskDetail>,
    private now: () => Date,
  ) {}
  async retry(input: {
    taskId: string;
    operationId: string;
    actor: Actor;
    body: OperationBodies['retryPublication'];
    key: string;
    requestId: string;
  }): Promise<{ data: ResponseModels['Publication']; replayed: boolean }> {
    const { actor } = input;
    if (
      ![
        input.taskId,
        input.operationId,
        input.body.accountId,
        input.body.contentVersionId,
        input.body.approvalId,
        input.body.previousDispatchId,
      ].every((id) => uuid.test(id))
    )
      throw new AuthError(404, 'NOT_FOUND', '任务、交接、版本、批准或前次发送不存在。');
    const taskId = input.taskId.toLowerCase(),
      operationId = input.operationId.toLowerCase();
    const body = {
      ...input.body,
      accountId: input.body.accountId.toLowerCase(),
      contentVersionId: input.body.contentVersionId.toLowerCase(),
      approvalId: input.body.approvalId.toLowerCase(),
      previousDispatchId: input.body.previousDispatchId.toLowerCase(),
      reason: input.body.reason.trim(),
    };
    if (!body.reason) throw new AuthError(422, 'VALIDATION_ERROR', '请填写本次重新交接原因。');
    const scopeHash = hash([actor.teamId, actor.id, 'retryPublication', taskId, operationId]),
      keyHash = hash(input.key);
    const fingerprint = hash([
      body.expectedRevision,
      body.accountId,
      body.contentVersionId,
      body.approvalId,
      body.contentHash,
      body.channel,
      body.previousDispatchId,
      body.reason,
    ]);
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
        const [operation] = await tx
          .select()
          .from(publicationOperations)
          .where(
            and(
              eq(publicationOperations.id, operationId),
              eq(publicationOperations.taskId, taskId),
            ),
          )
          .for('update');
        if (!operation) throw new AuthError(404, 'NOT_FOUND', '交接不存在或不属于本任务。');
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
            '同一动作标识不能提交不同的重新交接请求。',
          );
        if (
          body.accountId !== operation.accountId ||
          body.contentVersionId !== operation.contentVersionId ||
          body.contentHash !== operation.contentHash ||
          body.approvalId !== operation.snapshot.approval.id
        )
          throw new AuthError(
            409,
            'APPROVAL_INVALID',
            '请求与原交接的账号、批准版本或摘要不一致。',
          );
        if (body.channel !== 'manual')
          throw new AuthError(501, 'NOT_IMPLEMENTED', '当前仅支持重新创建人工交接。');
        const finish = async (replayed: boolean) => {
          const [fresh] = await tx
            .select()
            .from(publicationOperations)
            .where(eq(publicationOperations.id, operationId));
          const dispatches = await tx
            .select()
            .from(publicationDispatches)
            .where(eq(publicationDispatches.operationId, operationId))
            .orderBy(publicationDispatches.dispatchNo);
          const records = await tx
            .select()
            .from(publicationVerifications)
            .where(eq(publicationVerifications.operationId, operationId))
            .orderBy(publicationVerifications.createdAt, publicationVerifications.id);
          const data = {
            operation: publicationModel(
              fresh!,
              dispatches,
              records.map((r) => r.data),
            ),
            task: await this.read(tx, taskId, actor),
          };
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
        // Permanent predecessor identity survives HTTP key expiry and later retry rounds.
        const [child] = await tx
          .select()
          .from(publicationDispatches)
          .where(
            and(
              eq(publicationDispatches.operationId, operationId),
              eq(publicationDispatches.previousDispatchId, body.previousDispatchId),
            ),
          );
        if (child) return finish(true);
        if (cached && cached.expiresAt > now)
          throw new AuthError(409, 'INVALID_STATE', '原重新交接结果需核对，请先查询原操作。');
        if (operation.currentDispatchId !== body.previousDispatchId)
          throw new AuthError(409, 'REVISION_CONFLICT', '前次发送已变化，请刷新核对当前交接。');
        if (task.revision !== body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务、账号或批准已更新，请重新打开确认面板核对。',
          );
        const detail = await this.read(tx, taskId, actor);
        if (detail.currentPublication?.id !== operationId || !detail.actions.retry_publish.allowed)
          throw new AuthError(
            task.activePublishOperationId ? 423 : 409,
            task.activePublishOperationId ? 'PUBLICATION_LOCKED' : 'APPROVAL_INVALID',
            detail.actions.retry_publish.reason ?? '当前交接不具备重新交接资格。',
          );
        const [previous] = await tx
          .select()
          .from(publicationDispatches)
          .where(
            and(
              eq(publicationDispatches.operationId, operationId),
              eq(publicationDispatches.id, body.previousDispatchId),
            ),
          );
        if (!previous || previous.status !== 'failed' || operation.status !== 'failed')
          throw new AuthError(409, 'INVALID_STATE', '仅明确未发布的已结束人工交接可以重试。');
        const id = randomUUID();
        await tx.insert(publicationDispatches).values({
          id,
          operationId,
          dispatchNo: previous.dispatchNo + 1,
          previousDispatchId: previous.id,
          reason: body.reason,
          approvalId: operation.snapshot.approval.id,
          channel: 'manual',
          status: 'awaiting_manual',
          startedBy: actor.id,
          startedAt: now,
        });
        await tx
          .update(publicationOperations)
          .set({ status: 'awaiting_manual', currentDispatchId: id, updatedAt: now })
          .where(eq(publicationOperations.id, operationId));
        await tx
          .update(tasks)
          .set({
            activePublishOperationId: operationId,
            revision: task.revision + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, taskId));
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action: 'publication.retry_requested',
          targetType: 'publication',
          targetId: operationId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          outcome: 'succeeded',
          reason: body.reason,
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
        '重新交接结果尚未确认，请先查询原操作，或使用原动作标识确认。',
      );
    }
  }
}
