import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type {
  Account,
  OperationParams,
  ResponseModels,
  OperationBodies,
  OperationQueries,
  Page,
  Session,
  TaskDetail,
  TaskSummary,
  ReviewCycle,
  Approval,
  ManualDecision,
  PublishOperation,
  PublicationStatus,
} from '@multi-agent-ops/shared';
import { AuthError } from './auth.js';
import type { createBusinessDatabase } from './database.js';
import {
  accounts,
  configVersions,
  auditEvents,
  executionAttempts,
  taskContents,
  idempotencyRecords,
  members,
  tasks,
  taskReviews,
  taskApprovals,
  taskDecisions,
  publicationOperations,
  publicationDispatches,
  publicationVerifications,
} from './schema.js';
import { activeAttempt, attemptModel, contentModel } from './execution-model.js';
import { TaskExecutionService } from './task-execution-service.js';
import { EditorialService } from './editorial-service.js';
import type { EditorialRequest } from './editorial-service.js';
import { AccountService } from './account-service.js';
import { manualEntryReason } from './manual-publication-entry.js';
import { manualRetryReason } from './manual-publication-retry.js';
import { PublicationRetryService } from './publication-retry-service.js';
import { PublicationResultService } from './publication-result-service.js';
import { PublicationService } from './publication-service.js';
import { publicationModel } from './publication-model.js';
import { reviewEligible } from './manual-review.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Connection = Database | Transaction;
const replayMilliseconds = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const currentPublicationId = sql`coalesce(${tasks.activePublishOperationId},${tasks.publishedOperationId},(SELECT history.id FROM task_publication_operations history WHERE history.task_id=${tasks.id} AND history.content_version_id=${tasks.currentContentVersionId} ORDER BY history.created_at DESC,history.id DESC LIMIT 1))`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskDetail(
  task: typeof tasks.$inferSelect,
  account: Account | null,
  attempt: typeof executionAttempts.$inferSelect | null = null,
  content: typeof taskContents.$inferSelect | null = null,
  enabled = true,
  workflow: {
    publication?: PublishOperation | null;
    publicationStatus?: PublicationStatus | null;
    review?: ReviewCycle | null;
    approval?: Approval | null;
    decision?: ManualDecision | null;
    configVersion?: number | null;
    forbiddenTopics?: string[] | null;
  } = {},
): TaskDetail {
  if (!task.teamId || !task.createdBy)
    throw new AuthError(409, 'INVALID_STATE', '历史任务归属信息不完整，请联系管理员核对后补齐。');
  if (task.accountId && !account)
    throw new AuthError(409, 'INVALID_STATE', '任务绑定的账号不可用，请联系管理员核对团队归属。');
  const unavailable = { allowed: false, reason: '该操作尚未实现。' };
  const editingLocked =
    activeAttempt(task.executionStatus ?? '') || !!(attempt && activeAttempt(attempt.status));
  const detail: TaskDetail = {
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
      currentReviewCycleId: task.currentReviewCycleId,
      currentApprovalId: task.currentApprovalId,
      activePublishOperationId: task.activePublishOperationId,
      publishedOperationId: task.publishedOperationId,
      sourceTaskId: null,
      terminatedBy: null,
      terminatedAt: null,
      terminationReason: null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    execution: task.executionStatus === 'needs_human' ? 'manual_required' : task.executionStatus,
    approval: task.approvalStatus,
    publication: workflow.publication?.status ?? workflow.publicationStatus ?? 'not_published',
    reflection: 'not_triggered',
    currentStep: task.currentStep,
    errorMessage: task.errorMessage,
    currentAttempt: attempt ? attemptModel(attempt) : null,
    currentContent: content ? contentModel(content) : null,
    currentReview: workflow.review ?? null,
    currentApproval: workflow.approval ?? null,
    currentPublication: workflow.publication ?? null,
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
      save: {
        allowed: task.lifecycle === 'open' && !editingLocked,
        reason: editingLocked
          ? '请先停止或等待当前执行完成。'
          : task.lifecycle !== 'open'
            ? '任务已结束。'
            : null,
      },
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
      review: {
        allowed:
          task.lifecycle === 'open' &&
          !!content &&
          content.sourceKind === 'manual' &&
          !editingLocked,
        reason:
          content?.sourceKind !== 'manual'
            ? '请先人工编辑并保存文案。'
            : editingLocked
              ? '请先结束当前执行。'
              : null,
      },
      approve: {
        allowed:
          task.lifecycle === 'open' &&
          !editingLocked &&
          workflow.review?.currentVersionId === content?.id &&
          workflow.review?.configVersion === workflow.configVersion &&
          reviewEligible(workflow.review, workflow.decision),
        reason: '需完成当前版本的基础审核并解决阻断及主观意见。',
      },
      publish: unavailable,
      manual_publish_entry: unavailable,
      backfill: unavailable,
      verify: unavailable,
      retry_publish: unavailable,
      reflect: unavailable,
    },
  };
  const entryReason = manualEntryReason({
    task: detail.task,
    account,
    content: detail.currentContent,
    ...workflow,
    working: editingLocked || !!detail.workLock,
  });
  const reason =
    entryReason ??
    (workflow.publication?.status === 'failed'
      ? '该版本交接已结束，请保存新版本后重新审核批准。'
      : null);
  const retryReason = manualRetryReason(detail, workflow.publication ?? null, entryReason);
  detail.actions.retry_publish = { allowed: retryReason === null, reason: retryReason };
  detail.actions.manual_publish_entry = { allowed: reason === null, reason };
  detail.actions.publish = { allowed: reason === null, reason };
  if (task.activePublishOperationId || task.publishedOperationId) {
    for (const action of [
      'save',
      'start',
      'retry',
      'stop',
      'review',
      'approve',
      'terminate',
    ] as const)
      detail.actions[action] = { allowed: false, reason: '文案已冻结，请先处理原发布交接。' };
  }
  detail.actions.backfill = {
    allowed: workflow.publication?.status === 'awaiting_manual',
    reason:
      workflow.publication?.status === 'awaiting_manual' ? null : '当前没有待回填的人工交接。',
  };
  detail.actions.verify = {
    allowed: ['verification_required', 'published'].includes(workflow.publication?.status ?? ''),
    reason: ['verification_required', 'published'].includes(workflow.publication?.status ?? '')
      ? null
      : '当前交接不需要追加核实。',
  };
  return detail;
}

export class TaskService {
  constructor(
    private db: Database,
    private now: () => Date = () => new Date(),
    private options: { executorMode?: 'mock' | 'disabled'; stepDelayMs?: number } = {},
  ) {}

  accountRegistration(input: {
    operation: 'getAccountRegistration' | 'registerAccount';
    actor: Session['member'];
    body?: OperationBodies['registerAccount'];
    key: string;
    requestId: string;
  }) {
    const service = new AccountService(this.db, this.now);
    return input.operation === 'getAccountRegistration'
      ? service.get(input.actor).then((data) => ({ data, replayed: false }))
      : service.register({ ...input, body: input.body! });
  }
  async manualPublicationEntry(
    input: OperationParams['getManualPublicationEntry'] & { actor: Session['member'] },
  ): Promise<ResponseModels['ManualPublicationEntry']> {
    const detail = await this.get(input);
    if (!detail.actions.manual_publish_entry.allowed)
      throw new AuthError(
        409,
        'APPROVAL_INVALID',
        detail.actions.manual_publish_entry.reason ?? '当前版本不能进入人工发布。',
      );
    return {
      account: detail.account!,
      content: detail.currentContent!,
      approval: detail.currentApproval!,
      revision: detail.task.revision,
    };
  }

  editorial(input: EditorialRequest) {
    return new EditorialService(
      this.db,
      (connection, id, actor) => this.read(connection, id, actor),
      this.now,
    ).handle(input);
  }

  retryPublication(input: Parameters<PublicationRetryService['retry']>[0]) {
    return new PublicationRetryService(
      this.db,
      (connection, id, actor) => this.read(connection, id, actor),
      this.now,
    ).retry(input);
  }
  publicationResult(input: Parameters<PublicationResultService['record']>[0]) {
    return new PublicationResultService(
      this.db,
      (connection, id, actor) => this.read(connection, id, actor),
      this.now,
    ).record(input);
  }
  private publication() {
    return new PublicationService(
      this.db,
      (connection, id, actor) => this.read(connection, id, actor),
      this.now,
    );
  }
  publish(input: Parameters<PublicationService['publish']>[0]) {
    return this.publication().publish(input);
  }
  getPublication(input: Parameters<PublicationService['get']>[0]) {
    return this.publication().get(input);
  }
  listPublications(input: Parameters<PublicationService['list']>[0]) {
    return this.publication().list(input);
  }

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
          publicationStatus: publicationOperations.status,
          task: tasks,
          attempt: executionAttempts,
          content: taskContents,
          review: taskReviews.data,
          approval: taskApprovals.data,
          configVersion: accounts.currentConfigVersion,
          forbiddenTopics: configVersions.forbiddenTopics,
          // Preserve PostgreSQL microseconds for keyset pagination; JS Dates truncate them.
          time: sql<string>`to_char(${tasks.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          account: {
            id: accounts.id,
            displayName: accounts.displayName,
            platform: accounts.platform,
            authorizationStatus: accounts.authorizationStatus,
            officialPublishAvailable: accounts.officialPublishAvailable,
            platformAccountId: accounts.platformAccountId,
            manualPublishEnabled: accounts.manualPublishEnabled,
            registrationVersion: accounts.registrationVersion,
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
          configVersions,
          and(
            eq(configVersions.accountId, accounts.id),
            eq(configVersions.version, accounts.currentConfigVersion),
          ),
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
        .leftJoin(
          taskReviews,
          and(eq(taskReviews.id, tasks.currentReviewCycleId), eq(taskReviews.taskId, tasks.id)),
        )
        .leftJoin(
          taskApprovals,
          and(eq(taskApprovals.id, tasks.currentApprovalId), eq(taskApprovals.taskId, tasks.id)),
        )
        .leftJoin(
          publicationOperations,
          and(
            eq(publicationOperations.taskId, tasks.id),
            eq(publicationOperations.id, currentPublicationId),
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
            // Approval status is persisted and updated atomically with its bound version.
            query.approval ? eq(tasks.approvalStatus, query.approval) : undefined,
            query.publication
              ? eq(
                  sql`coalesce(${publicationOperations.status},'not_published')`,
                  query.publication,
                )
              : undefined,
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
        items: page.map(
          ({
            task,
            account,
            attempt,
            content,
            review,
            approval,
            configVersion,
            forbiddenTopics,
            publicationStatus,
          }) => {
            const detail = taskDetail(
              task,
              account,
              attempt,
              content,
              this.options.executorMode !== 'disabled',
              { review, approval, configVersion, forbiddenTopics, publicationStatus },
            );
            return {
              task: detail.task,
              execution: detail.execution,
              approval: detail.approval,
              publication: detail.publication,
              reflection: detail.reflection,
              currentStep: detail.currentStep,
            };
          },
        ),
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
          review: taskReviews.data,
          approval: taskApprovals.data,
          configVersion: accounts.currentConfigVersion,
          forbiddenTopics: configVersions.forbiddenTopics,
          account: {
            id: accounts.id,
            displayName: accounts.displayName,
            platform: accounts.platform,
            authorizationStatus: accounts.authorizationStatus,
            officialPublishAvailable: accounts.officialPublishAvailable,
            platformAccountId: accounts.platformAccountId,
            manualPublishEnabled: accounts.manualPublishEnabled,
            registrationVersion: accounts.registrationVersion,
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
          configVersions,
          and(
            eq(configVersions.accountId, accounts.id),
            eq(configVersions.version, accounts.currentConfigVersion),
          ),
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
        .leftJoin(
          taskReviews,
          and(eq(taskReviews.id, tasks.currentReviewCycleId), eq(taskReviews.taskId, tasks.id)),
        )
        .leftJoin(
          taskApprovals,
          and(eq(taskApprovals.id, tasks.currentApprovalId), eq(taskApprovals.taskId, tasks.id)),
        )
        .where(and(eq(tasks.id, taskId), eq(tasks.teamId, actor.teamId)));
      if (!row) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
      const [decision] = row.review
        ? await connection
            .select()
            .from(taskDecisions)
            .where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.reviewId, row.review.id)))
            .orderBy(desc(taskDecisions.createdAt), desc(taskDecisions.id))
            .limit(1)
        : [];
      const operationId = row.task.activePublishOperationId ?? row.task.publishedOperationId;
      let [operation] = operationId
        ? await connection
            .select()
            .from(publicationOperations)
            .where(
              and(
                eq(publicationOperations.id, operationId),
                eq(publicationOperations.taskId, taskId),
              ),
            )
        : [];
      if (operationId && !operation) throw new Error('Publication pointer is invalid');
      if (!operationId && row.task.currentContentVersionId)
        [operation] = await connection
          .select()
          .from(publicationOperations)
          .where(
            and(
              eq(publicationOperations.taskId, taskId),
              eq(publicationOperations.contentVersionId, row.task.currentContentVersionId),
            ),
          )
          .orderBy(desc(publicationOperations.createdAt), desc(publicationOperations.id))
          .limit(1);
      const observations = operation
        ? await connection
            .select()
            .from(publicationVerifications)
            .where(eq(publicationVerifications.operationId, operation.id))
            .orderBy(publicationVerifications.createdAt, publicationVerifications.id)
        : [];
      const dispatches = operation
        ? await connection
            .select()
            .from(publicationDispatches)
            .where(eq(publicationDispatches.operationId, operation.id))
            .orderBy(publicationDispatches.dispatchNo)
        : [];
      return taskDetail(
        row.task,
        row.account,
        row.attempt,
        row.content,
        this.options.executorMode !== 'disabled',
        {
          publication: operation
            ? publicationModel(
                operation,
                dispatches,
                observations.map((item) => item.data),
              )
            : null,
          review: row.review,
          approval: row.approval,
          configVersion: row.configVersion,
          forbiddenTopics: row.forbiddenTopics,
          decision: decision?.data ?? null,
        },
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
          return {
            data: {
              ...data,
              errorMessage: data.errorMessage ?? null,
              account: data.account
                ? {
                    ...data.account,
                    platformAccountId: data.account.platformAccountId ?? null,
                    manualPublishEnabled: data.account.manualPublishEnabled ?? false,
                    registrationVersion: data.account.registrationVersion ?? 0,
                  }
                : null,
              actions: {
                ...data.actions,
                manual_publish_entry: data.actions.manual_publish_entry ?? {
                  allowed: false,
                  reason: '请刷新详情后核对目标账号与批准版本。',
                },
              },
            },
            replayed: true,
          };
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
            platformAccountId: accounts.platformAccountId,
            manualPublishEnabled: accounts.manualPublishEnabled,
            registrationVersion: accounts.registrationVersion,
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
