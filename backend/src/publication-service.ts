import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  OperationBodies,
  OperationQueries,
  ResponseModels,
  Session,
  TaskDetail,
} from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { lockEditorialTeam } from './editorial-state.js';
import type { SimulationPublicationAdapter } from './publication-sender.js';
import { publicationPreflight } from './publication-preflight.js';
import { PublicationSender } from './publication-sender.js';
import { publicationModel } from './publication-model.js';
import {
  auditEvents,
  idempotencyRecords,
  members,
  publicationDispatches,
  publicationOperations,
  publicationVerifications,
  taskApprovals,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
type Actor = Session['member'];
type ReadTask = (connection: Connection, taskId: string, actor: Actor) => Promise<TaskDetail>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = sql<string>`to_char(${publicationOperations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export class PublicationService {
  constructor(
    private db: Database,
    private read: ReadTask,
    private now: () => Date,
    private simulationAdapter?: SimulationPublicationAdapter,
  ) {}
  private async model(connection: Connection, row: typeof publicationOperations.$inferSelect) {
    const dispatches = await connection
      .select()
      .from(publicationDispatches)
      .where(eq(publicationDispatches.operationId, row.id))
      .orderBy(publicationDispatches.dispatchNo);
    const observations = await connection
      .select()
      .from(publicationVerifications)
      .where(eq(publicationVerifications.operationId, row.id))
      .orderBy(publicationVerifications.createdAt, publicationVerifications.id);
    return publicationModel(
      row,
      dispatches,
      observations.map((item) => item.data),
    );
  }
  async get(input: {
    taskId: string;
    operationId: string;
    actor: Actor;
  }): Promise<ResponseModels['Publication']> {
    try {
      const task = await this.read(this.db, input.taskId, input.actor);
      if (!uuid.test(input.operationId)) throw new AuthError(404, 'NOT_FOUND', '交接记录不存在。');
      const [row] = await this.db
        .select()
        .from(publicationOperations)
        .where(
          and(
            eq(publicationOperations.taskId, task.task.id),
            eq(publicationOperations.id, input.operationId),
          ),
        );
      if (!row) throw new AuthError(404, 'NOT_FOUND', '交接记录不存在或不属于此任务。');
      return { operation: await this.model(this.db, row), task };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '交接记录暂不可读，请稍后查询；原交接仍保留。',
      );
    }
  }
  async list(input: {
    taskId: string;
    actor: Actor;
    query: OperationQueries['listPublications'];
  }): Promise<ResponseModels['Publications']> {
    const task = await this.read(this.db, input.taskId, input.actor);
    let cursor: { time: string; id: string } | undefined;
    if (input.query.cursor) {
      try {
        const c = JSON.parse(Buffer.from(input.query.cursor, 'base64url').toString('utf8'));
        if (
          c.taskId !== task.task.id ||
          !uuid.test(c.id) ||
          typeof c.time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.time) ||
          !Number.isFinite(Date.parse(c.time))
        )
          throw new Error('invalid cursor');
        cursor = c;
      } catch {
        throw new AuthError(400, 'VALIDATION_ERROR', '交接记录分页位置无效，请重新读取。');
      }
    }
    try {
      const limit = input.query.limit ?? 20;
      const rows = await this.db
        .select({ row: publicationOperations, time })
        .from(publicationOperations)
        .where(
          and(
            eq(publicationOperations.taskId, task.task.id),
            cursor
              ? sql`(${publicationOperations.createdAt},${publicationOperations.id}) < (${cursor.time}::timestamptz,${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(publicationOperations.createdAt), desc(publicationOperations.id))
        .limit(limit + 1);
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);
      return {
        items: await Promise.all(selected.map((item) => this.model(this.db, item.row))),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ taskId: task.task.id, id: last.row.id, time: last.time }),
              ).toString('base64url')
            : null,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '交接历史暂不可读，请稍后重试。');
    }
  }
  async publish(input: {
    taskId: string;
    actor: Actor;
    body: Omit<OperationBodies['publishContent'], 'channel'> & {
      channel: OperationBodies['publishContent']['channel'] | 'simulation';
    };
    key: string;
    requestId: string;
  }): Promise<{ data: ResponseModels['Publication']; replayed: boolean }> {
    const { actor } = input;
    if (
      ![
        input.taskId,
        input.body.accountId,
        input.body.approvalId,
        input.body.contentVersionId,
      ].every((id) => uuid.test(id))
    )
      throw new AuthError(404, 'NOT_FOUND', '任务、账号、版本或批准记录不存在。');
    const taskId = input.taskId.toLowerCase();
    const body = {
      ...input.body,
      accountId: input.body.accountId.toLowerCase(),
      approvalId: input.body.approvalId.toLowerCase(),
      contentVersionId: input.body.contentVersionId.toLowerCase(),
    };
    const scopeHash = hash([actor.teamId, actor.id, 'publishContent', taskId]);
    const keyHash = hash(input.key);
    const fingerprint = hash([
      body.expectedRevision,
      body.accountId,
      body.contentVersionId,
      body.approvalId,
      body.contentHash,
      body.channel,
    ]);
    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        const lock = Buffer.from(hash([scopeHash, keyHash]), 'hex')
          .readBigInt64BE()
          .toString();
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lock}::bigint)`);
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
        if (body.accountId !== task.accountId)
          throw new AuthError(409, 'ACCOUNT_UNAUTHORIZED', '目标账号与任务绑定账号不一致。');
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
            '同一动作标识不能提交不同的交接请求。',
          );
        const [prior] = await tx
          .select()
          .from(publicationOperations)
          .where(
            and(
              eq(publicationOperations.taskId, taskId),
              eq(publicationOperations.contentVersionId, body.contentVersionId),
              eq(publicationOperations.accountId, body.accountId),
            ),
          );
        const finish = async (
          row: typeof publicationOperations.$inferSelect,
          replayed: boolean,
        ) => {
          const data = {
            operation: await this.model(tx, row),
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
        // Reusing the business identity never sends, recreates or revives a dispatch.
        if (prior) return finish(prior, true);
        if (cached && cached.expiresAt > now)
          throw new AuthError(409, 'INVALID_STATE', '原交接记录需核对，请先查询任务详情。');
        if (task.activePublishOperationId)
          throw new AuthError(423, 'PUBLICATION_LOCKED', '已有未完成交接，请先处理原操作。');
        if (task.revision !== body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务、账号或批准版本已变化，请重新核对后提交。',
          );
        const detail = await this.read(tx, taskId, actor);
        if (
          detail.currentApproval?.id !== body.approvalId ||
          detail.currentContent?.id !== body.contentVersionId ||
          detail.currentContent?.contentHash !== body.contentHash
        )
          throw new AuthError(409, 'APPROVAL_INVALID', '请求与当前批准版本、摘要不一致。');
        const preflightFailure = await publicationPreflight(tx, detail);
        if (preflightFailure)
          throw new AuthError(
            409,
            preflightFailure.code === 'PUBLICATION_CANCELLED'
              ? 'INVALID_STATE'
              : 'APPROVAL_INVALID',
            preflightFailure.message,
          );
        if (!detail.actions.manual_publish_entry.allowed)
          throw new AuthError(
            detail.workLock ? 423 : 409,
            detail.workLock ? 'WORK_LOCKED' : 'APPROVAL_INVALID',
            detail.actions.manual_publish_entry.reason ?? '当前版本不具备交接资格。',
          );
        if (body.channel !== 'manual' && !(body.channel === 'simulation' && this.simulationAdapter))
          throw new AuthError(501, 'NOT_IMPLEMENTED', '官方发布尚未接入；当前只支持人工交接。');
        const [previousSuccess] = await tx
          .select({ id: publicationOperations.id })
          .from(publicationOperations)
          .where(
            and(
              eq(publicationOperations.taskId, taskId),
              eq(publicationOperations.status, 'published'),
            ),
          );
        if (previousSuccess) throw new AuthError(409, 'INVALID_STATE', '该任务已有成功发布记录。');
        const [approval] = await tx
          .select()
          .from(taskApprovals)
          .where(and(eq(taskApprovals.id, body.approvalId), eq(taskApprovals.taskId, taskId)));
        if (!approval || approval.configVersion !== detail.currentReview!.configVersion)
          throw new AuthError(409, 'APPROVAL_INVALID', '批准的配置版本已变化。');
        const operationId = randomUUID(),
          dispatchId = randomUUID();
        const [operation] = await tx
          .insert(publicationOperations)
          .values({
            id: operationId,
            taskId,
            accountId: body.accountId,
            contentVersionId: body.contentVersionId,
            contentHash: body.contentHash,
            approvalId: body.approvalId,
            configVersion: approval.configVersion,
            snapshot: {
              content: detail.currentContent!,
              account: detail.account!,
              approval: detail.currentApproval!,
              configVersion: approval.configVersion,
              frozenAt: now.toISOString(),
            },
            status: body.channel === 'simulation' ? 'publishing' : 'awaiting_manual',
            currentDispatchId: dispatchId,
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await tx.insert(publicationDispatches).values({
          id: dispatchId,
          operationId,
          dispatchNo: 1,
          approvalId: body.approvalId,
          channel: body.channel,
          status: body.channel === 'simulation' ? 'publishing' : 'awaiting_manual',
          startedBy: actor.id,
          startedAt: now,
        });
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
          action:
            body.channel === 'simulation'
              ? 'publication.simulation_requested'
              : 'publication.handed_off',
          targetType: 'publication',
          targetId: operationId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          outcome: 'succeeded',
          requestId: input.requestId,
          createdAt: now,
        });
        return finish(operation!, false);
      });
      if (!result.replayed && body.channel === 'simulation' && this.simulationAdapter) {
        await new PublicationSender(this.db, this.read, this.now, this.simulationAdapter).send({
          taskId,
          operationId: result.data.operation.id,
          dispatchId: result.data.operation.currentDispatchId,
          actor,
        });
        return {
          data: await this.get({ taskId, operationId: result.data.operation.id, actor }),
          replayed: false,
        };
      }
      return result;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '交接结果尚未确认，请先查询原操作，或使用原请求标识确认。',
      );
    }
  }
}
