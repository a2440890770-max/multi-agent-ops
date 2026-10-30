import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type {
  Account,
  OperationBodies,
  OperationQueries,
  Page,
  Session,
  TaskDetail,
  TaskSummary,
} from '@multi-agent-ops/shared';
import { AuthError } from './auth.js';
import type { createBusinessDatabase } from './database.js';
import {
  accounts,
  auditEvents,
  executionAttempts,
  taskContents,
  idempotencyRecords,
  members,
  tasks,
} from './schema.js';
import { activeAttempt, attemptModel, contentModel } from './execution-model.js';
import { TaskExecutionService } from './task-execution-service.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
const replayMilliseconds = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskDetail(
  task: typeof tasks.$inferSelect,
  account: Account | null,
  attempt: typeof executionAttempts.$inferSelect | null = null,
  content: typeof taskContents.$inferSelect | null = null,
  enabled = true,
): TaskDetail {
  if (!task.teamId || !task.createdBy)
    throw new AuthError(409, 'INVALID_STATE', '历史任务归属信息不完整，请联系管理员核对后补齐。');
  if (task.accountId && !account)
    throw new AuthError(409, 'INVALID_STATE', '任务绑定的账号不可用，请联系管理员核对团队归属。');
  const unavailable = { allowed: false, reason: '该操作尚未实现。' };
  return {
    task: {
      id: task.id,
      teamId: task.teamId,
      createdBy: task.createdBy,
      accountId: task.accountId,
      title: task.title,
      originalRequest: task.originalRequest,
      referenceInputs: task.referenceInputs,
      lifecycle: task.lifecycle,
      revision: task.revision,
      clarifications: attempt?.clarifications ?? [],
      currentAttemptId: task.currentAttemptId,
      currentContentVersionId: task.currentContentVersionId,
      currentReviewCycleId: null,
      currentApprovalId: null,
      activePublishOperationId: null,
      publishedOperationId: null,
      sourceTaskId: null,
      terminatedBy: null,
      terminatedAt: null,
      terminationReason: null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    execution: task.executionStatus === 'needs_human' ? 'manual_required' : task.executionStatus,
    approval: 'not_requested',
    publication: 'not_published',
    reflection: 'not_triggered',
    currentStep: task.currentStep,
    errorMessage: task.errorMessage,
    currentAttempt: attempt ? attemptModel(attempt) : null,
    currentContent: content ? contentModel(content) : null,
    currentReview: null,
    currentApproval: null,
    currentPublication: null,
    latestReflection: null,
    workLock:
      attempt && activeAttempt(attempt.status)
        ? {
            ownerType: 'attempt',
            ownerId: attempt.id,
            generation: attempt.generation,
            cancelRequested: false,
          }
        : null,
    account,
    actions: {
      save: unavailable,
      start: {
        allowed: enabled && task.lifecycle === 'open' && !attempt && task.executionStatus === null,
        reason: !enabled
          ? '模拟执行器未启用。'
          : task.lifecycle !== 'open'
            ? '任务已结束。'
            : attempt
              ? '已有执行记录，请使用重新执行。'
              : task.executionStatus !== null
                ? '历史执行状态缺少尝试记录，请先核对。'
                : null,
      },
      stop: {
        allowed: !!attempt && activeAttempt(attempt.status) && task.lifecycle === 'open',
        reason:
          !attempt || !activeAttempt(attempt.status)
            ? '当前没有可停止的尝试。'
            : task.lifecycle !== 'open'
              ? '任务已结束。'
              : null,
      },
      terminate: unavailable,
      retry: {
        allowed:
          enabled && task.lifecycle === 'open' && !!attempt && !activeAttempt(attempt.status),
        reason: !enabled
          ? '模拟执行器未启用。'
          : !attempt
            ? '尚无执行记录。'
            : activeAttempt(attempt.status)
              ? '当前尝试尚未结束，请先停止。'
              : task.lifecycle !== 'open'
                ? '任务已结束。'
                : null,
      },
      copy: unavailable,
      review: unavailable,
      approve: unavailable,
      publish: unavailable,
      backfill: unavailable,
      verify: unavailable,
      retry_publish: unavailable,
      reflect: unavailable,
    },
  };
}

export class TaskService {
  constructor(
    private db: Database,
    private now: () => Date = () => new Date(),
    private options: { executorMode?: 'mock' | 'disabled'; stepDelayMs?: number } = {},
  ) {}

  private execution() {
    return new TaskExecutionService(
      this.db,
      (connection, id, actor) => this.read(connection, id, actor),
      this.now,
      this.options,
    );
  }
  start(input: Parameters<TaskExecutionService['start']>[0]) {
    return this.execution().start(input);
  }
  retry(input: Parameters<TaskExecutionService['retry']>[0]) {
    return this.execution().retry(input);
  }
  stop(input: Parameters<TaskExecutionService['stop']>[0]) {
    return this.execution().stop(input);
  }
  history(input: Parameters<TaskExecutionService['history']>[0]) {
    return this.execution().history(input);
  }
  clarify(input: Parameters<TaskExecutionService['clarify']>[0]) {
    return this.execution().clarify(input);
  }

  async list(input: {
    query: OperationQueries['listTasks'];
    actor: Session['member'];
  }): Promise<Page<TaskSummary>> {
    const { query, actor } = input;
    const scope = digest(
      JSON.stringify([
        actor.teamId,
        query.q ?? '',
        query.lifecycle ?? '',
        query.execution ?? '',
        query.approval ?? '',
        query.publication ?? '',
      ]),
    );
    let cursor: { time: string; id: string } | undefined;
    if (query.cursor) {
      try {
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (
          value.v !== 1 ||
          value.scope !== scope ||
          typeof value.time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.time) ||
          !Number.isFinite(Date.parse(value.time)) ||
          typeof value.id !== 'string' ||
          !uuidPattern.test(value.id)
        )
          throw new Error('invalid cursor');
        cursor = value;
      } catch {
        throw new AuthError(
          400,
          'VALIDATION_ERROR',
          '分页位置无效或筛选条件已改变，请重新加载列表。',
        );
      }
    }
    const limit = query.limit ?? 20;
    const search = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    try {
      const rows = await this.db
        .select({
          task: tasks,
          attempt: executionAttempts,
          content: taskContents,
          // Preserve PostgreSQL microseconds for keyset pagination; JS Dates truncate them.
          time: sql<string>`to_char(${tasks.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          account: {
            id: accounts.id,
            displayName: accounts.displayName,
            platform: accounts.platform,
            authorizationStatus: accounts.authorizationStatus,
            officialPublishAvailable: accounts.officialPublishAvailable,
          },
        })
        .from(tasks)
        .innerJoin(
          members,
          and(
            eq(members.id, actor.id),
            eq(members.teamId, tasks.teamId),
            eq(members.status, 'active'),
            eq(members.role, actor.role),
            eq(members.version, actor.version),
          ),
        )
        .leftJoin(
          accounts,
          and(eq(accounts.id, tasks.accountId), eq(accounts.teamId, tasks.teamId)),
        )

        .leftJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
          ),
        )
        .leftJoin(
          taskContents,
          and(
            eq(taskContents.id, tasks.currentContentVersionId),
            eq(taskContents.taskId, tasks.id),
          ),
        )
        .where(
          and(
            eq(tasks.teamId, actor.teamId),
            query.lifecycle ? eq(tasks.lifecycle, query.lifecycle) : undefined,
            query.execution
              ? eq(
                  tasks.executionStatus,
                  query.execution === 'manual_required' ? 'needs_human' : query.execution,
                )
              : undefined,
            // Approval and publishing workflows are not stored yet. Filter the same
            // values returned by the current summary rather than inventing workflow state.
            query.approval && query.approval !== 'not_requested' ? sql`false` : undefined,
            query.publication && query.publication !== 'not_published' ? sql`false` : undefined,
            search
              ? or(sql`${tasks.title} ILIKE ${search}`, sql`${tasks.id}::text ILIKE ${search}`)
              : undefined,
            cursor
              ? sql`(${tasks.updatedAt}, ${tasks.id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ task, account, attempt, content }) => {
          const detail = taskDetail(
            task,
            account,
            attempt,
            content,
            this.options.executorMode !== 'disabled',
          );
          return {
            task: detail.task,
            execution: detail.execution,
            approval: detail.approval,
            publication: detail.publication,
            reflection: detail.reflection,
            currentStep: detail.currentStep,
          };
        }),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ v: 1, scope, time: last.time, id: last.task.id }),
              ).toString('base64url')
            : null,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务列表服务暂不可用，请稍后重试。');
    }
  }

  async get(input: { taskId: string; actor: Session['member'] }): Promise<TaskDetail> {
    return this.read(this.db, input.taskId, input.actor);
  }

  private async read(
    connection: Connection,
    taskId: string,
    actor: Session['member'],
  ): Promise<TaskDetail> {
    // Wire IDs remain opaque. Values that cannot identify a stored UUID are missing,
    // rather than PostgreSQL cast errors exposed as service failures.
    if (!uuidPattern.test(taskId)) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
    try {
      // One statement gives a consistent task/account snapshot and rechecks membership.
      // Join the bound account only; do not assign today's default account to old drafts.
      const [row] = await connection
        .select({
          task: tasks,
          attempt: executionAttempts,
          content: taskContents,
          account: {
            id: accounts.id,
            displayName: accounts.displayName,
            platform: accounts.platform,
            authorizationStatus: accounts.authorizationStatus,
            officialPublishAvailable: accounts.officialPublishAvailable,
          },
        })
        .from(tasks)
        .innerJoin(
          members,
          and(
            eq(members.id, actor.id),
            eq(members.teamId, tasks.teamId),
            eq(members.status, 'active'),
            eq(members.role, actor.role),
            eq(members.version, actor.version),
          ),
        )
        .leftJoin(
          accounts,
          and(eq(accounts.id, tasks.accountId), eq(accounts.teamId, tasks.teamId)),
        )

        .leftJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
          ),
        )
        .leftJoin(
          taskContents,
          and(
            eq(taskContents.id, tasks.currentContentVersionId),
            eq(taskContents.taskId, tasks.id),
          ),
        )
        .where(and(eq(tasks.id, taskId), eq(tasks.teamId, actor.teamId)));
      if (!row) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
      return taskDetail(
        row.task,
        row.account,
        row.attempt,
        row.content,
        this.options.executorMode !== 'disabled',
      );
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务查询服务暂不可用，请稍后重试。');
    }
  }

  async create(input: {
    body: OperationBodies['createTask'];
    actor: Session['member'];
    key: string;
    requestId: string;
  }): Promise<{ data: TaskDetail; replayed: boolean }> {
    const { body, actor } = input;
    const references = (body.referenceInputs ?? []).map(({ label, url }) => ({ label, url }));
    if (
      !body.title.trim() ||
      !body.originalRequest.trim() ||
      references.some((r) => !r.label.trim())
    )
      throw new AuthError(
        400,
        'VALIDATION_ERROR',
        '任务标题、原始要求及参考资料名称不能仅包含空白。',
      );
    const scopeHash = digest(
      JSON.stringify(['createTask', actor.teamId, actor.id, 'POST', '/api/v1/tasks']),
    );
    const keyHash = digest(input.key);
    const requestFingerprint = digest(
      JSON.stringify({
        title: body.title,
        originalRequest: body.originalRequest,
        referenceInputs: references,
      }),
    );
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
        const lock = Buffer.from(digest(`${scopeHash}:${keyHash}`), 'hex')
          .readBigInt64BE()
          .toString();
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lock}::bigint)`);
        // Keep ownership and current membership stable until the task is committed.
        const [member] = await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.id, actor.id),
              eq(members.teamId, actor.teamId),
              eq(members.status, 'active'),
              eq(members.role, actor.role),
              eq(members.version, actor.version),
            ),
          )
          .for('share');
        if (!member) throw new AuthError(403, 'FORBIDDEN', '成员身份已变更，请刷新身份后重试。');
        const now = this.now();
        const [existing] = await tx
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.scopeHash, scopeHash),
              eq(idempotencyRecords.keyHash, keyHash),
            ),
          );
        if (existing && existing.expiresAt.getTime() > now.getTime()) {
          if (existing.requestFingerprint !== requestFingerprint)
            throw new AuthError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              '同一动作标识不能用于不同的创建请求。',
            );
          if (
            existing.status !== 'completed' ||
            existing.responseStatus !== 201 ||
            !existing.responseBody
          )
            throw new AuthError(409, 'INVALID_STATE', '创建请求尚未完成，请稍后重试。');
          const data = existing.responseBody as TaskDetail;
          const [task] = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.id, data.task.id),
                eq(tasks.teamId, actor.teamId),
                eq(tasks.createdBy, actor.id),
              ),
            );
          if (!task) throw new AuthError(404, 'NOT_FOUND', '原任务不存在或已不可访问。');
          // Cached creates from before detail queries shipped lack this additive field.
          return { data: { ...data, errorMessage: data.errorMessage ?? null }, replayed: true };
        }
        if (existing)
          await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, existing.id));
        const [account] = await tx
          .select({
            id: accounts.id,
            displayName: accounts.displayName,
            platform: accounts.platform,
            authorizationStatus: accounts.authorizationStatus,
            officialPublishAvailable: accounts.officialPublishAvailable,
          })
          .from(accounts)
          .where(eq(accounts.teamId, actor.teamId))
          .for('share');
        const [task] = await tx
          .insert(tasks)
          .values({
            title: body.title,
            originalRequest: body.originalRequest,
            teamId: actor.teamId,
            createdBy: actor.id,
            accountId: account?.id ?? null,
            referenceInputs: references.map((r) => ({ id: randomUUID(), ...r })),
            lifecycle: 'open',
            revision: 1,
            executionStatus: null,
            currentStep: null,
            errorMessage: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!task) throw new Error('task insert failed');
        const data = taskDetail(
          task,
          account ?? null,
          null,
          null,
          this.options.executorMode !== 'disabled',
        );
        await tx.insert(idempotencyRecords).values({
          scopeHash,
          keyHash,
          requestFingerprint,
          status: 'completed',
          responseStatus: 201,
          responseBody: data,
          createdAt: now,
          expiresAt: new Date(now.getTime() + replayMilliseconds),
        });
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          actorType: 'member',
          actorId: actor.id,
          taskId: task.id,
          action: 'task.created',
          targetType: 'task',
          targetId: task.id,
          afterRevision: 1,
          outcome: 'succeeded',
          requestId: input.requestId,
          createdAt: now,
        });
        return { data, replayed: false };
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '任务保存服务暂不可用，请稍后使用同一动作标识重试。',
      );
    }
  }
}
