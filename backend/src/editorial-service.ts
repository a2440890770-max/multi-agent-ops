import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  Approval,
  ConfigVersion,
  ManualDecision,
  OperationBodies,
  ReviewCycle,
  ReviewIssue,
  Session,
  TaskDetail,
} from '@multi-agent-ops/shared';
import { AuthError } from './auth.js';
import type { createBusinessDatabase } from './database.js';
import { contentModel } from './execution-model.js';
import { invalidateApproval, lockEditorialTeam } from './editorial-state.js';
import type { EditorialTransaction } from './editorial-state.js';
import { basicIssues, defaultEditorialConfig, reviewEligible } from './manual-review.js';
import {
  accounts,
  auditEvents,
  configVersions,
  idempotencyRecords,
  members,
  taskApprovals,
  taskContents,
  taskDecisions,
  taskReviews,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Connection = Database | EditorialTransaction;
type Actor = Session['member'];
type ReadTask = (connection: Connection, id: string, actor: Actor) => Promise<TaskDetail>;
export const editorialOperations = new Set([
  'listContent',
  'getContent',
  'compareContent',
  'saveContent',
  'submitReview',
  'listReviews',
  'getReview',
  'decideReview',
  'listDecisions',
  'approveContent',
  'getConfig',
  'updateConfig',
  'publishContent',
]);
export type EditorialRequest = {
  operation: string;
  actor: Actor;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  key: string;
  requestId: string;
};
type Body = {
  expectedRevision: number;
  baseContentVersionId?: string | null;
  body?: string;
  contentVersionId?: string;
  subjectiveNote?: string;
  reviewRecordId?: string;
  reason?: string;
  acceptedIssues?: string[];
  unresolvedIssues?: string[];
  evidenceIds?: string[];
  reviewCycleId?: string;
  accountId?: string;
  contentHash?: string;
  approvalId?: string;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (
  code: 'REVISION_CONFLICT' | 'INVALID_STATE' | 'APPROVAL_INVALID' | 'REVIEW_BLOCKED',
  message: string,
): never => {
  throw new AuthError(409, code, message);
};
const validateId = (id: string | undefined) => {
  if (!id || !uuid.test(id)) throw new AuthError(404, 'NOT_FOUND', '记录不存在或不可访问。');
};

export function compareBodies(from: string, to: string) {
  const a = [...from],
    b = [...to];
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return [
    { kind: 'equal' as const, text: a.slice(0, prefix).join('') },
    { kind: 'delete' as const, text: a.slice(prefix, a.length - suffix).join('') },
    { kind: 'insert' as const, text: b.slice(prefix, b.length - suffix).join('') },
    { kind: 'equal' as const, text: suffix ? a.slice(-suffix).join('') : '' },
  ].filter((c) => c.text);
}

function page<T extends { id: string }>(rows: T[], query: Record<string, unknown>) {
  let start = 0;
  if (query.cursor) {
    const cursor = Buffer.from(String(query.cursor), 'base64url').toString();
    const found = rows.findIndex((r) => r.id === cursor);
    if (found < 0) throw new AuthError(400, 'VALIDATION_ERROR', '分页位置无效，请重新加载。');
    start = found + 1;
  }
  const limit = Number(query.limit ?? 20),
    items = rows.slice(start, start + limit);
  return {
    items,
    nextCursor:
      start + limit < rows.length ? Buffer.from(items.at(-1)!.id).toString('base64url') : null,
  };
}

export class EditorialService {
  constructor(
    private db: Database,
    private read: ReadTask,
    private now: () => Date,
  ) {}

  async handle(
    input: EditorialRequest,
  ): Promise<{ data: unknown; status: number; replayed: boolean }> {
    try {
      if (input.operation === 'getConfig')
        return { data: await this.getConfig(this.db, input.actor), status: 200, replayed: false };
      if (
        [
          'listContent',
          'getContent',
          'compareContent',
          'listReviews',
          'getReview',
          'listDecisions',
        ].includes(input.operation)
      )
        return { data: await this.readRecords(input), status: 200, replayed: false };
      return await this.write(input);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '人工编辑审核服务暂不可用，请保留输入并重试确认；若刚更新代码，请先完成数据库迁移。',
      );
    }
  }

  private async getConfig(connection: Connection, actor: Actor): Promise<ConfigVersion> {
    const [row] = await connection
      .select({ config: configVersions })
      .from(accounts)
      .innerJoin(
        configVersions,
        and(
          eq(configVersions.accountId, accounts.id),
          eq(configVersions.version, accounts.currentConfigVersion),
        ),
      )
      .innerJoin(
        members,
        and(
          eq(members.id, actor.id),
          eq(members.teamId, accounts.teamId),
          eq(members.status, 'active'),
          eq(members.version, actor.version),
          eq(members.role, actor.role),
        ),
      )
      .where(eq(accounts.teamId, actor.teamId));
    if (!row)
      throw new AuthError(
        404,
        'NOT_FOUND',
        '尚未初始化文案配置。保存配置或首次保存文案时会初始化。',
      );
    const c = row.config;
    return {
      accountId: c.accountId,
      version: c.version,
      profile: c.profile,
      tone: c.tone,
      forbiddenTopics: c.forbiddenTopics,
      rules: c.rules,
      modelRef: c.modelRef,
      promptVersion: c.promptVersion,
      toolVersion: c.toolVersion,
      maxAutoRevisions: 3,
      updatedBy: c.updatedBy,
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private async config(tx: EditorialTransaction, actor: Actor, now: Date) {
    let [account] = await tx.select().from(accounts).where(eq(accounts.teamId, actor.teamId));
    if (!account)
      [account] = await tx
        .insert(accounts)
        .values({
          teamId: actor.teamId,
          displayName: '团队文案账号',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    if (!account) throw new Error('account initialization failed');
    if (!account.currentConfigVersion) {
      await tx.insert(configVersions).values({
        ...defaultEditorialConfig,
        accountId: account.id,
        version: 1,
        changeReason: '初始化人工编辑与基础审核配置',
        updatedBy: actor.id,
        updatedAt: now,
      });
      await tx
        .update(accounts)
        .set({ currentConfigVersion: 1, updatedAt: now })
        .where(eq(accounts.id, account.id));
    }
    return this.getConfig(tx, actor);
  }

  private async readRecords(input: EditorialRequest) {
    const taskId = input.params.taskId!;
    await this.read(this.db, taskId, input.actor);
    if (['listContent', 'getContent', 'compareContent'].includes(input.operation)) {
      const rows = await this.db
        .select()
        .from(taskContents)
        .where(eq(taskContents.taskId, taskId))
        .orderBy(desc(taskContents.versionNo));
      const versions = rows.map(contentModel);
      const find = (id: string | undefined) => {
        validateId(id);
        const value = versions.find((v) => v.id === id?.toLowerCase());
        if (!value) throw new AuthError(404, 'NOT_FOUND', '版本不存在或不属于此任务。');
        return value;
      };
      if (input.operation === 'listContent') return page(versions, input.query);
      if (input.operation === 'getContent') return find(input.params.versionId);
      const from = find(String(input.query.fromVersionId)),
        to = find(String(input.query.toVersionId));
      return { from, to, changes: compareBodies(from.body, to.body) };
    }
    const rows = await this.db
      .select()
      .from(taskReviews)
      .where(eq(taskReviews.taskId, taskId))
      .orderBy(sql`${taskReviews.data}->>'createdAt' DESC`, desc(taskReviews.id));
    if (input.operation === 'listReviews')
      return page(
        rows.map((r) => r.data),
        input.query,
      );
    validateId(input.params.reviewId);
    const review = rows.find((r) => r.id === input.params.reviewId?.toLowerCase());
    if (!review) throw new AuthError(404, 'NOT_FOUND', '审核不存在或不属于此任务。');
    if (input.operation === 'getReview') return review.data;
    const decisions = await this.db
      .select()
      .from(taskDecisions)
      .where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.reviewId, review.id)))
      .orderBy(desc(taskDecisions.createdAt), desc(taskDecisions.id));
    return page(
      decisions.map((d) => d.data),
      input.query,
    );
  }

  private async write(input: EditorialRequest) {
    const scopeHash = hash([input.actor.teamId, input.actor.id, input.operation, input.params]);
    const keyHash = hash(input.key),
      fingerprint = hash(input.body);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${Buffer.from(hash([scopeHash, keyHash]), 'hex')
          .readBigInt64BE()
          .toString()}::bigint)`,
      );
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
      if (!member) throw new AuthError(403, 'FORBIDDEN', '成员身份已变更，请重新登录。');
      const now = this.now();
      if (input.operation !== 'updateConfig')
        await this.read(tx, input.params.taskId!, input.actor);
      const [cached] = await tx
        .select()
        .from(idempotencyRecords)
        .where(
          and(eq(idempotencyRecords.scopeHash, scopeHash), eq(idempotencyRecords.keyHash, keyHash)),
        );
      if (cached && cached.expiresAt > now) {
        if (cached.requestFingerprint !== fingerprint)
          throw new AuthError(409, 'IDEMPOTENCY_KEY_REUSED', '同一操作标识不能提交不同内容。');
        if (!cached.responseBody || !cached.responseStatus)
          fail('INVALID_STATE', '操作尚未确认，请重试确认。');
        return { data: cached.responseBody, status: cached.responseStatus!, replayed: true };
      }
      if (cached) await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, cached.id));
      const result =
        input.operation === 'updateConfig'
          ? await this.updateConfig(tx, input, now)
          : await this.changeTask(tx, input, now);
      await tx.insert(idempotencyRecords).values({
        scopeHash,
        keyHash,
        requestFingerprint: fingerprint,
        status: 'completed',
        responseStatus: result.status,
        responseBody: result.data,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86400000),
      });
      return { ...result, replayed: false };
    });
  }

  private async audit(
    tx: EditorialTransaction,
    input: EditorialRequest,
    now: Date,
    action: string,
    before: number | null,
    after: number | null,
    reason: string | null = null,
  ) {
    await tx.insert(auditEvents).values({
      teamId: input.actor.teamId,
      taskId: input.params.taskId ?? null,
      actorType: 'member',
      actorId: input.actor.id,
      action,
      targetType: input.params.taskId ? 'task' : 'config',
      targetId: input.params.taskId ?? input.actor.teamId,
      beforeRevision: before,
      afterRevision: after,
      outcome: 'succeeded',
      reason,
      requestId: input.requestId,
      createdAt: now,
    });
  }

  private async updateConfig(tx: EditorialTransaction, input: EditorialRequest, now: Date) {
    if (input.actor.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '仅管理员可修改配置。');
    const body = input.body as OperationBodies['updateConfig'];
    if (
      !body.reason.trim() ||
      !body.profile.trim() ||
      !body.tone.trim() ||
      body.forbiddenTopics.some((t) => !t.trim())
    )
      throw new AuthError(400, 'VALIDATION_ERROR', '简介、语气、禁止事项及变更原因不能仅为空白。');
    if (
      body.rules.length !== 1 ||
      body.rules.some(
        (r) =>
          r.id !== defaultEditorialConfig.rules[0]!.id ||
          r.description !== defaultEditorialConfig.rules[0]!.description ||
          r.deterministic !== true,
      )
    )
      throw new AuthError(
        422,
        'VALIDATION_ERROR',
        '当前仅支持内置纯文案与 280 字符规则；禁止事项请填写明确词语。',
      );
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.teamId, input.actor.teamId));
    const current = account?.currentConfigVersion ?? 0;
    if (body.expectedVersion !== (current || 1))
      fail('REVISION_CONFLICT', '配置已更新，请刷新后比较再保存。');
    const initial = await this.config(tx, input.actor, now);
    const next = current ? current + 1 : 1;
    // Initialization already wrote an immutable V1. A customized first save is V2.
    const version = next === 1 ? 2 : next;
    const { expectedVersion: ignored, reason, ...fields } = body;
    void ignored;
    await tx.insert(configVersions).values({
      ...fields,
      accountId: initial.accountId,
      version,
      maxAutoRevisions: 3,
      changeReason: reason,
      updatedBy: input.actor.id,
      updatedAt: now,
    });
    await tx
      .update(accounts)
      .set({ currentConfigVersion: version, updatedAt: now })
      .where(eq(accounts.id, initial.accountId));
    const affected = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.teamId, input.actor.teamId), eq(tasks.accountId, initial.accountId)))
      .orderBy(tasks.id)
      .for('update');
    for (const task of affected) {
      await invalidateApproval(tx, task, now, '账号配置已变更，需要重新审核和批准。');
      await tx
        .update(tasks)
        .set({
          revision: task.revision + 1,
          approvalStatus: task.currentApprovalId ? 'invalidated' : task.approvalStatus,
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
    }
    await this.audit(tx, input, now, 'config.updated', current, version, reason);
    return { status: 200, data: await this.getConfig(tx, input.actor) };
  }

  private async changeTask(tx: EditorialTransaction, input: EditorialRequest, now: Date) {
    const taskId = input.params.taskId!;
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.teamId, input.actor.teamId)))
      .for('update');
    if (!task) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
    const body = input.body as Body;
    if (task.revision !== body.expectedRevision)
      fail('REVISION_CONFLICT', '任务已更新，输入已保留；请比较服务器当前版本后重新操作。');
    if (task.lifecycle !== 'open') fail('INVALID_STATE', '任务已结束，不能修改或批准。');
    const detail = await this.read(tx, taskId, input.actor);
    if (
      detail.workLock ||
      ['queued', 'running', 'awaiting_clarification'].includes(detail.execution ?? '')
    )
      throw new AuthError(423, 'WORK_LOCKED', '当前执行尚未结束，请先停止或等待完成。');
    const config = await this.config(tx, input.actor, now);
    if (task.accountId && task.accountId !== config.accountId)
      fail('INVALID_STATE', '任务账号与团队账号不一致。');
    if (input.operation === 'saveContent') {
      if (body.baseContentVersionId !== task.currentContentVersionId)
        fail('REVISION_CONFLICT', '文案基础版本已变化，请比较后保存。');
      if (!body.body?.trim()) throw new AuthError(400, 'VALIDATION_ERROR', '文案不能仅为空白。');
      const [last] = await tx
        .select()
        .from(taskContents)
        .where(eq(taskContents.taskId, taskId))
        .orderBy(desc(taskContents.versionNo))
        .limit(1);
      const [content] = await tx
        .insert(taskContents)
        .values({
          taskId,
          versionNo: (last?.versionNo ?? 0) + 1,
          parentVersionId: task.currentContentVersionId ?? last?.id ?? null,
          sourceKind: 'manual',
          body: body.body,
          contentHash: createHash('sha256').update(body.body, 'utf8').digest('hex'),
          createdBy: input.actor.id,
          createdAt: now,
        })
        .returning();
      await invalidateApproval(tx, task, now, '文案已编辑，旧批准不能用于新版本。');
      await tx
        .update(tasks)
        .set({
          accountId: config.accountId,
          currentContentVersionId: content!.id,
          currentReviewCycleId: null,
          approvalStatus: task.currentApprovalId ? 'invalidated' : 'pending',
          revision: task.revision + 1,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
      await this.audit(tx, input, now, 'content.saved', task.revision, task.revision + 1);
      return {
        status: 201,
        data: {
          task: await this.read(tx, taskId, input.actor),
          content: contentModel(content!),
          message: '新版本已保存，需要提交审核',
        },
      };
    }
    if (!detail.currentContent || body.contentVersionId !== detail.currentContent.id)
      fail('REVISION_CONFLICT', '请求绑定的文案版本已过期，请刷新后重试。');
    const content = detail.currentContent!;
    if (input.operation === 'submitReview') {
      if (content.sourceKind !== 'manual')
        fail('REVIEW_BLOCKED', '模拟产出不能直接取得审核资格，请先人工编辑并保存。');
      const issues: ReviewIssue[] = basicIssues(content.body, config.forbiddenTopics);
      if (body.subjectiveNote?.trim())
        issues.push({
          id: randomUUID(),
          kind: 'subjective',
          message: body.subjectiveNote,
          resolved: false,
        });
      const id = randomUUID(),
        at = now.toISOString();
      const cycle: ReviewCycle = {
        id,
        taskId,
        attemptId: null,
        trigger: 'manual_submit',
        inputVersionId: content.id,
        currentVersionId: content.id,
        status: 'completed',
        records: [
          {
            id: randomUUID(),
            cycleId: id,
            contentVersionId: content.id,
            outcome: issues.some((i) => i.kind !== 'subjective')
              ? 'changes_required'
              : issues.length
                ? 'manual_required'
                : 'pass',
            checks: [
              `账号简介：${config.profile}`,
              `语气偏好：${config.tone}`,
              `禁止事项：${config.forbiddenTopics.join('、') || '无'}`,
              `字符数：${[...content.body].length} / 280`,
              '检查纯文案格式与当前配置的禁止词。',
              '主观意见由审核人填写；未执行事实核验或模型评审。',
            ],
            blockingIssues: issues,
            scores: [],
            sourceRefs: [],
            createdAt: at,
          },
        ],
        requestedBy: input.actor.id,
        configVersion: config.version,
        createdAt: at,
        finishedAt: at,
        error: null,
      };
      await tx.insert(taskReviews).values({
        id,
        taskId,
        contentVersionId: content.id,
        configVersion: config.version,
        data: cycle,
      });
      await invalidateApproval(tx, task, now, '已提交新的审核记录，需要重新批准。');
      await tx
        .update(tasks)
        .set({
          accountId: config.accountId,
          currentReviewCycleId: id,
          approvalStatus: task.currentApprovalId ? 'invalidated' : 'pending',
          revision: task.revision + 1,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
      await this.audit(tx, input, now, 'review.completed', task.revision, task.revision + 1);
      return { status: 202, data: cycle };
    }
    const review = detail.currentReview;
    if (
      !review ||
      review.currentVersionId !== content.id ||
      review.configVersion !== config.version
    )
      fail('REVIEW_BLOCKED', '当前版本尚未按最新配置审核，请重新提交审核。');
    if (input.operation === 'decideReview') {
      if (input.params.reviewId !== review!.id)
        fail('REVISION_CONFLICT', '审核记录已变化，请刷新后裁决。');
      const record = review!.records.find((r) => r.id === body.reviewRecordId);
      if (!record) throw new AuthError(400, 'VALIDATION_ERROR', '审核记录不属于当前审核。');
      const issues = record.blockingIssues;
      if (issues.some((i) => i.kind !== 'subjective'))
        fail('REVIEW_BLOCKED', '确定性阻断或事实问题不能通过人工裁决绕过，请修改后重审。');
      if (!body.reason?.trim())
        throw new AuthError(400, 'VALIDATION_ERROR', '请填写有效的裁决理由。');
      const accepted = body.acceptedIssues ?? [],
        unresolved = body.unresolvedIssues ?? [],
        all = [...accepted, ...unresolved];
      if (
        !issues.length ||
        new Set(all).size !== all.length ||
        all.length !== issues.length ||
        all.some((id) => !issues.some((i) => i.id === id))
      )
        throw new AuthError(
          400,
          'VALIDATION_ERROR',
          '裁决须覆盖全部主观意见，接受和未解决的项目不能重叠。',
        );
      const evidenceIds = body.evidenceIds ?? [];
      if (evidenceIds.some((id) => !task.referenceInputs.some((r) => r.id === id)))
        throw new AuthError(400, 'VALIDATION_ERROR', '证据必须来自此任务的参考资料。');
      const [previousDecision] = await tx
        .select({ createdAt: taskDecisions.createdAt })
        .from(taskDecisions)
        .where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.reviewId, review!.id)))
        .orderBy(desc(taskDecisions.createdAt))
        .limit(1);
      // Keep decision order stable when commands share a millisecond or test clock.
      const decisionAt = new Date(
        Math.max(now.getTime(), (previousDecision?.createdAt.getTime() ?? 0) + 1),
      );
      const decision: ManualDecision = {
        id: randomUUID(),
        reviewRecordId: record.id,
        actorId: input.actor.id,
        reason: body.reason,
        acceptedIssues: accepted,
        unresolvedIssues: unresolved,
        evidenceRefs: task.referenceInputs.filter((r) => evidenceIds.includes(r.id)),
        createdAt: decisionAt.toISOString(),
      };
      await tx.insert(taskDecisions).values({
        id: decision.id,
        taskId,
        reviewId: review!.id,
        data: decision,
        createdAt: decisionAt,
      });
      await invalidateApproval(tx, task, now, '人工裁决已更新，需要重新批准。');
      await tx
        .update(tasks)
        .set({
          revision: task.revision + 1,
          approvalStatus: task.currentApprovalId ? 'invalidated' : 'pending',
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
      await this.audit(
        tx,
        input,
        now,
        'review.decided',
        task.revision,
        task.revision + 1,
        body.reason,
      );
      return { status: 201, data: { decision, task: await this.read(tx, taskId, input.actor) } };
    }
    const [decision] = await tx
      .select()
      .from(taskDecisions)
      .where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.reviewId, review!.id)))
      .orderBy(desc(taskDecisions.createdAt), desc(taskDecisions.id))
      .limit(1);
    if (
      !reviewEligible(review, decision?.data) ||
      basicIssues(content.body, config.forbiddenTopics).length
    )
      fail('REVIEW_BLOCKED', '仍有阻断或未裁决的主观意见，不能批准或发布。');
    if (input.operation === 'approveContent') {
      if (
        body.reviewCycleId !== review!.id ||
        body.accountId !== config.accountId ||
        body.contentHash !== content.contentHash
      )
        fail('APPROVAL_INVALID', '批准绑定的版本、摘要、账号或审核不匹配。');
      if (
        detail.currentApproval?.status === 'approved' &&
        detail.currentApproval.contentVersionId === content.id
      )
        return { status: 200, data: { approval: detail.currentApproval, task: detail } };
      const approval: Approval = {
        id: randomUUID(),
        taskId,
        contentVersionId: content.id,
        contentHash: content.contentHash,
        accountId: config.accountId,
        reviewCycleId: review!.id,
        status: 'approved',
        approvedBy: input.actor.id,
        approvedAt: now.toISOString(),
        invalidatedAt: null,
        invalidatedReason: null,
      };
      await tx.insert(taskApprovals).values({
        id: approval.id,
        taskId,
        contentVersionId: content.id,
        reviewCycleId: review!.id,
        accountId: config.accountId,
        configVersion: config.version,
        data: approval,
      });
      await tx
        .update(tasks)
        .set({
          currentApprovalId: approval.id,
          approvalStatus: 'approved',
          revision: task.revision + 1,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
      await this.audit(tx, input, now, 'approval.created', task.revision, task.revision + 1);
      return { status: 201, data: { approval, task: await this.read(tx, taskId, input.actor) } };
    }
    const approval = detail.currentApproval;
    if (
      !approval ||
      approval.status !== 'approved' ||
      approval.id !== body.approvalId ||
      approval.contentVersionId !== content.id ||
      approval.contentHash !== body.contentHash ||
      approval.accountId !== body.accountId ||
      approval.reviewCycleId !== review!.id
    )
      fail('APPROVAL_INVALID', '批准已失效或与当前版本不匹配，拒绝发布。');
    throw new AuthError(
      501,
      'NOT_IMPLEMENTED',
      '批准校验通过；实际发布通道尚未接入，本次未发布内容。',
    );
  }
}
