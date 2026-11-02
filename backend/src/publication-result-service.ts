import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  OperationBodies,
  ResponseModels,
  Session,
  TaskDetail,
  VerificationRecord,
} from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { lockEditorialTeam } from './editorial-state.js';
import { observation } from './publication-observation.js';
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
export class PublicationResultService {
  constructor(
    private db: Database,
    private read: (connection: Connection, id: string, actor: Actor) => Promise<TaskDetail>,
    private now: () => Date,
  ) {}
  async record(input: {
    taskId: string;
    operationId: string;
    actor: Actor;
    kind: 'backfill' | 'verification';
    body: OperationBodies['backfillPublication'];
    key: string;
    requestId: string;
  }): Promise<{ data: ResponseModels['Publication']; replayed: boolean }> {
    const { actor } = input;
    if (
      ![
        input.taskId,
        input.operationId,
        input.body.dispatchId,
        input.body.accountId,
        input.body.contentVersionId,
      ].every((id) => uuid.test(id))
    )
      throw new AuthError(404, 'NOT_FOUND', '任务、交接、发送或批准版本不存在。');
    const taskId = input.taskId.toLowerCase(),
      operationId = input.operationId.toLowerCase();
    const body = {
      ...input.body,
      dispatchId: input.body.dispatchId.toLowerCase(),
      accountId: input.body.accountId.toLowerCase(),
      contentVersionId: input.body.contentVersionId.toLowerCase(),
    };
    const command = {
      accountId: body.accountId,
      contentVersionId: body.contentVersionId,
      dispatchId: body.dispatchId,
      conclusion: body.conclusion,
      url: body.url ?? null,
      platformPostId: body.platformPostId ?? null,
      observedAccountUid: body.observedAccountUid ?? null,
      observedBody: body.observedBody ?? null,
      observedContentHash: body.observedContentHash ?? null,
      evidenceIds: body.evidenceIds,
      note: body.note,
      manualConfirmed: body.manualConfirmed ?? false,
      previousDispatchFenced: body.previousDispatchFenced ?? false,
    };
    const scopeHash = hash([actor.teamId, actor.id, input.kind, taskId, operationId]),
      keyHash = hash(input.key);
    const fingerprint = hash([body.expectedRevision, command]);
    const factHash = hash([actor.id, input.kind, command]);
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
              eq(members.version, actor.version),
              eq(members.role, actor.role),
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
        if (!operation) throw new AuthError(404, 'NOT_FOUND', '交接不属于此任务。');
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
            '同一动作标识不能提交不同的回填或核实资料。',
          );
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
        const [prior] = await tx
          .select()
          .from(publicationVerifications)
          .where(
            and(
              eq(publicationVerifications.operationId, operationId),
              eq(publicationVerifications.factHash, factHash),
            ),
          );
        if (prior) return finish(true);
        if (cached && cached.expiresAt > now)
          throw new AuthError(409, 'INVALID_STATE', '原回填记录需核对，请先查询交接结果。');
        if (
          body.dispatchId !== operation.currentDispatchId ||
          body.accountId !== operation.accountId ||
          body.contentVersionId !== operation.contentVersionId
        )
          throw new AuthError(
            409,
            'APPROVAL_INVALID',
            '发送编号、绑定账号或批准版本与原交接不一致。',
          );
        const [dispatch] = await tx
          .select()
          .from(publicationDispatches)
          .where(
            and(
              eq(publicationDispatches.operationId, operationId),
              eq(publicationDispatches.id, body.dispatchId),
            ),
          );
        if (!dispatch || dispatch.channel !== 'manual')
          throw new AuthError(409, 'INVALID_STATE', '本接口仅支持当前人工交接。');
        const published = operation.status === 'published';
        if (
          !published &&
          operation.status !==
            (input.kind === 'backfill' ? 'awaiting_manual' : 'verification_required')
        )
          throw new AuthError(
            409,
            'INVALID_STATE',
            '交接状态已变化，请刷新后使用当前回填或核实入口。',
          );
        if (
          (published && task.publishedOperationId !== operationId) ||
          (!published &&
            (task.activePublishOperationId !== operationId ||
              task.lifecycle !== 'open' ||
              task.currentContentVersionId !== operation.contentVersionId))
        )
          throw new AuthError(
            423,
            'PUBLICATION_LOCKED',
            '原交接已结束或已有其他活动操作，请查询原记录。',
          );
        if (task.revision !== body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务或核实结果已更新，输入已保留，请刷新比较后重新提交。',
          );
        if (
          new Set(body.evidenceIds).size !== body.evidenceIds.length ||
          body.evidenceIds.some((id) => !task.referenceInputs.some((ref) => ref.id === id))
        )
          throw new AuthError(422, 'VALIDATION_ERROR', '证据引用必须来自本任务，且不能重复。');
        const model = publicationModel(operation, [dispatch]);
        const result = observation(body, model);
        const records = await tx
          .select()
          .from(publicationVerifications)
          .where(eq(publicationVerifications.operationId, operationId))
          .orderBy(publicationVerifications.createdAt);
        const at = new Date(
          Math.max(now.getTime(), (records.at(-1)?.createdAt.getTime() ?? 0) + 1),
        );
        const record: VerificationRecord = {
          id: randomUUID(),
          kind: input.kind,
          operationId,
          dispatchId: dispatch.id,
          actorId: actor.id,
          accountId: operation.accountId,
          contentVersionId: operation.contentVersionId,
          method: 'manual',
          requestedConclusion: body.conclusion,
          conclusion: result.conclusion,
          observedAccountUid: body.observedAccountUid ?? null,
          observedBody: result.observedBody,
          observedContentHash: result.observedHash,
          platformPostId: result.link?.postId ?? null,
          url: result.link?.url ?? null,
          evidenceRefs: [
            ...task.referenceInputs.filter((ref) => body.evidenceIds.includes(ref.id)),
            { id: randomUUID(), label: body.note.trim(), url: result.link?.url ?? null },
          ],
          note: body.note,
          manualConfirmed: body.manualConfirmed ?? false,
          previousDispatchFenced: body.previousDispatchFenced ?? false,
          mismatchNote: result.mismatchNote,
          resultingStatus: result.status,
          createdAt: at.toISOString(),
        };
        await tx.insert(publicationVerifications).values({
          id: record.id,
          operationId,
          dispatchId: dispatch.id,
          actorId: actor.id,
          factHash,
          data: record,
          createdAt: at,
        });
        await tx
          .update(publicationOperations)
          .set({ status: result.status, updatedAt: now })
          .where(eq(publicationOperations.id, operationId));
        if (!published)
          await tx
            .update(publicationDispatches)
            .set({
              status: result.status,
              finishedAt: result.status === 'verification_required' ? null : now,
              url: result.link?.url ?? null,
              platformPostId: result.link?.postId ?? null,
              error:
                result.status === 'failed'
                  ? { code: 'MANUAL_NOT_PUBLISHED', message: body.note, retryable: false }
                  : null,
            })
            .where(eq(publicationDispatches.id, dispatch.id));
        await tx
          .update(tasks)
          .set({
            revision: task.revision + 1,
            updatedAt: now,
            ...(!published
              ? {
                  activePublishOperationId:
                    result.status === 'verification_required' ? operationId : null,
                  publishedOperationId: result.status === 'published' ? operationId : null,
                  lifecycle:
                    result.status === 'published' ? ('published' as const) : ('open' as const),
                }
              : {}),
          })
          .where(eq(tasks.id, taskId));
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action: input.kind === 'backfill' ? 'publication.backfilled' : 'publication.verified',
          targetType: 'publication',
          targetId: operationId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          outcome: 'succeeded',
          reason: result.mismatchNote ?? body.note,
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
        '回填结果尚未确认，请先查询原交接；原请求可使用同一动作标识确认。',
      );
    }
  }
}
