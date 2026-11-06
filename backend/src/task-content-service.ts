import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ManualDecision, OperationBodies, Session, TaskDetail } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { AuthError } from './auth.js';
import { activeAttempt, contentModel, reviewModel } from './execution-model.js';
import { basicIssues } from './review-policy.js';
import {
  auditEvents,
  executionAttempts,
  executionSteps,
  idempotencyRecords,
  manualDecisions,
  members,
  reviewCycles,
  taskContents,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ReadTask = (
  connection: Database | Transaction,
  id: string,
  actor: Session['member'],
) => Promise<TaskDetail>;
export type ContentOperation =
  'saveContent' | 'submitReview' | 'stopReview' | 'decideReview' | 'terminateTask';
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class TaskContentService {
  constructor(
    private db: Database,
    private read: ReadTask,
    private now: () => Date,
    private mode: 'mock' | 'agent' | 'disabled',
  ) {}

  async command(input: {
    kind: ContentOperation;
    taskId: string;
    reviewId?: string;
    actor: Session['member'];
    body: OperationBodies[ContentOperation];
    key: string;
    requestId: string;
  }) {
    const { kind, taskId, actor } = input;
    if (!uuid.test(taskId) || (input.reviewId && !uuid.test(input.reviewId)))
      throw new AuthError(404, 'NOT_FOUND', '任务或审核不存在或不可访问。');
    const scopeHash = hash([actor.teamId, actor.id, kind, taskId, input.reviewId ?? null]);
    const keyHash = hash(input.key),
      fingerprint = hash(input.body);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${Buffer.from(hash([scopeHash, keyHash]), 'hex')
            .readBigInt64BE()
            .toString()}::bigint)`,
        );
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
        if (!member) throw new AuthError(403, 'FORBIDDEN', '成员身份已变更，请刷新身份。');
        const [task] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.teamId, actor.teamId)))
          .for('update');
        if (!task) throw new AuthError(404, 'NOT_FOUND', '任务不存在或不可访问。');
        const detail = await this.read(tx, taskId, actor);
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
        if (cached && cached.expiresAt > now) {
          if (cached.requestFingerprint !== fingerprint)
            throw new AuthError(409, 'IDEMPOTENCY_KEY_REUSED', '同一动作标识不能用于不同请求。');
          if (cached.status !== 'completed' || !cached.responseBody)
            throw new AuthError(409, 'INVALID_STATE', '操作尚未确认，请使用同一动作标识重试。');
          return { data: cached.responseBody, replayed: true };
        }
        if (cached) await tx.delete(idempotencyRecords).where(eq(idempotencyRecords.id, cached.id));
        if (task.revision !== input.body.expectedRevision)
          throw new AuthError(
            409,
            'REVISION_CONFLICT',
            '任务状态已更新，请刷新后重试；本地编辑内容已保留。',
          );
        if (task.lifecycle !== 'open')
          throw new AuthError(409, 'INVALID_STATE', '任务已结束，不能执行此操作。');
        if (kind !== 'terminateTask' && kind !== 'stopReview' && detail.workLock)
          throw new AuthError(423, 'WORK_LOCKED', '请先人工接管并停止当前执行或审核，再编辑。');
        let response: unknown, action: string;
        let reason: string | null = null;
        const next = { revision: task.revision + 1, updatedAt: now };
        if (kind === 'saveContent') {
          const body = input.body as OperationBodies['saveContent'];
          if (!body.body.trim()) throw new AuthError(400, 'VALIDATION_ERROR', '文案不能为空。');
          if (body.baseContentVersionId !== task.currentContentVersionId)
            throw new AuthError(
              409,
              'REVISION_CONFLICT',
              '基础内容版本已变化，请刷新并核对后保存。',
            );
          const [count] = await tx
            .select({ max: sql<number>`coalesce(max(${taskContents.versionNo}),0)::integer` })
            .from(taskContents)
            .where(eq(taskContents.taskId, taskId));
          const [content] = await tx
            .insert(taskContents)
            .values({
              taskId,
              originAttemptId: task.currentAttemptId,
              parentVersionId: task.currentContentVersionId,
              versionNo: (count?.max ?? 0) + 1,
              sourceKind: 'manual',
              revisionRound: detail.currentAttempt?.autoRevisionCount ?? 0,
              body: body.body,
              contentHash: createHash('sha256').update(body.body).digest('hex'),
              createdBy: actor.id,
              createdAt: now,
            })
            .returning();
          const issues = basicIssues(body.body);
          await tx
            .update(tasks)
            .set({
              ...next,
              currentContentVersionId: content!.id,
              currentReviewCycleId: null,
              workGeneration: task.workGeneration + 1,
              executionStatus: 'needs_human',
              currentStep: '人工版本已保存，等待提交审核',
              errorMessage: issues.length ? issues.map((i) => i.message).join('；') : null,
            })
            .where(eq(tasks.id, taskId));
          response = {
            task: await this.read(tx, taskId, actor),
            content: contentModel(content!),
            message: '新版本已保存，需要提交审核',
          };
          action = 'content.saved';
        } else if (kind === 'submitReview') {
          const body = input.body as OperationBodies['submitReview'];
          if (this.mode === 'disabled') throw new AuthError(409, 'INVALID_STATE', '执行器未启用。');
          if (!detail.currentContent || body.contentVersionId !== task.currentContentVersionId)
            throw new AuthError(409, 'REVISION_CONFLICT', '只能审核当前已保存版本。');
          if (
            detail.currentReview?.status === 'completed' &&
            detail.currentReview.currentVersionId === body.contentVersionId &&
            detail.currentReview.records.at(-1)?.outcome === 'pass'
          ) {
            response = detail.currentReview;
          } else {
            const generation = task.workGeneration + 1;
            const [cycle] = await tx
              .insert(reviewCycles)
              .values({
                taskId,
                attemptId: task.currentAttemptId,
                trigger: 'manual_submit',
                inputVersionId: body.contentVersionId,
                currentVersionId: body.contentVersionId,
                status: 'queued',
                requestedBy: actor.id,
                generation,
                executorMode: this.mode,
                createdAt: now,
              })
              .returning();
            await tx
              .update(tasks)
              .set({
                ...next,
                currentReviewCycleId: cycle!.id,
                workGeneration: generation,
                executionStatus: 'running',
                currentStep: '等待人工版本审核',
                errorMessage: null,
              })
              .where(eq(tasks.id, taskId));
            response = reviewModel(cycle!);
          }
          action = 'review.submitted';
        } else if (kind === 'decideReview') {
          const body = input.body as OperationBodies['decideReview'];
          const cycle = detail.currentReview,
            record = cycle?.records.at(-1);
          reason = body.reason;
          if (!body.reason.trim()) throw new AuthError(400, 'VALIDATION_ERROR', '请填写裁决理由。');
          if (
            !cycle ||
            cycle.id !== input.reviewId ||
            cycle.status !== 'completed' ||
            !record ||
            record.id !== body.reviewRecordId ||
            body.contentVersionId !== task.currentContentVersionId ||
            record.contentVersionId !== task.currentContentVersionId
          )
            throw new AuthError(409, 'INVALID_STATE', '只能裁决当前版本最新的已完成审核。');
          if (
            record.blockingIssues.some((i) => !i.resolved && i.kind !== 'subjective') ||
            record.factualEvidenceSufficient === false ||
            basicIssues(detail.currentContent!.body).length
          )
            throw new AuthError(
              422,
              'REVIEW_BLOCKED',
              '事实证据不足或基础校验问题不能裁决放行，请修改后重审。',
            );
          const issues = record.blockingIssues.filter((i) => !i.resolved).map((i) => i.id);
          const all = [...body.acceptedIssues, ...body.unresolvedIssues];
          if (
            !issues.length ||
            new Set(all).size !== all.length ||
            all.length !== issues.length ||
            all.some((id) => !issues.includes(id))
          )
            throw new AuthError(
              400,
              'VALIDATION_ERROR',
              '裁决必须完整覆盖全部主观问题，且接受与保留的意见不能重复。',
            );
          const knownEvidence = [
            ...task.referenceInputs.map((s) => s.id),
            task.id,
            task.currentAttemptId,
          ];
          if (body.evidenceIds.some((id) => !knownEvidence.includes(id)))
            throw new AuthError(400, 'VALIDATION_ERROR', '裁决证据不属于本任务。');
          const decision: ManualDecision = {
            id: randomUUID(),
            reviewRecordId: record.id,
            actorId: actor.id,
            reason: body.reason,
            acceptedIssues: body.acceptedIssues,
            unresolvedIssues: body.unresolvedIssues,
            evidenceRefs: task.referenceInputs.filter((s) => body.evidenceIds.includes(s.id)),
            createdAt: now.toISOString(),
          };
          await tx
            .insert(manualDecisions)
            .values({ id: decision.id, taskId, reviewCycleId: cycle.id, data: decision });
          const ready = body.unresolvedIssues.length === 0;
          await tx
            .update(tasks)
            .set({
              ...next,
              executionStatus: ready ? 'ready' : 'needs_human',
              currentStep: ready ? '人工裁决通过' : '人工裁决保留问题',
              errorMessage: ready ? null : '仍有未解决的主观问题。',
            })
            .where(eq(tasks.id, taskId));
          response = { decision, task: await this.read(tx, taskId, actor) };
          action = 'review.decided';
        } else {
          const body = input.body as OperationBodies['terminateTask'];
          reason = body.reason;
          if (!reason.trim()) throw new AuthError(400, 'VALIDATION_ERROR', '请填写操作原因。');
          if (
            kind === 'stopReview' &&
            (!detail.currentReview ||
              detail.currentReview.id !== input.reviewId ||
              detail.currentReview.trigger !== 'manual_submit' ||
              !['queued', 'running'].includes(detail.currentReview.status))
          )
            throw new AuthError(409, 'INVALID_STATE', '当前没有可停止的人工审核。');
          // Fencing is immediate: all external calls are read/generate only, and
          // their commits must match workGeneration before touching any data.
          if (detail.currentAttempt && activeAttempt(detail.currentAttempt.status)) {
            await tx
              .update(executionAttempts)
              .set({
                status: 'cancelled',
                currentStep: '已终止',
                cancelScope: 'terminate_task',
                cancelRequestedAt: now,
                cancelRequestedBy: actor.id,
                cancelReason: reason,
                stoppedAt: now,
                finishedAt: now,
                nextRunAt: null,
              })
              .where(eq(executionAttempts.id, detail.currentAttempt.id));
            await tx
              .update(executionSteps)
              .set({ status: 'cancelled', finishedAt: now, leaseToken: null, leaseExpiresAt: null })
              .where(
                and(
                  eq(executionSteps.attemptId, detail.currentAttempt.id),
                  inArray(executionSteps.status, ['queued', 'running']),
                ),
              );
          }
          if (detail.currentReview && ['queued', 'running'].includes(detail.currentReview.status))
            await tx
              .update(reviewCycles)
              .set({ status: 'cancelled', finishedAt: now, leaseToken: null, leaseExpiresAt: null })
              .where(eq(reviewCycles.id, detail.currentReview.id));
          await tx
            .update(tasks)
            .set({
              ...next,
              workGeneration: task.workGeneration + 1,
              executionStatus: 'cancelled',
              currentStep: kind === 'terminateTask' ? '任务已终止' : '人工审核已停止',
              errorMessage: null,
              ...(kind === 'terminateTask'
                ? {
                    lifecycle: 'terminated' as const,
                    terminatedBy: actor.id,
                    terminatedAt: now,
                    terminationReason: reason,
                  }
                : {}),
            })
            .where(eq(tasks.id, taskId));
          response = await this.read(tx, taskId, actor);
          action = kind === 'terminateTask' ? 'task.terminated' : 'review.cancelled';
        }
        const fresh = await this.read(tx, taskId, actor);
        await tx.insert(auditEvents).values({
          teamId: actor.teamId,
          taskId,
          actorType: 'member',
          actorId: actor.id,
          action,
          targetType: 'task',
          targetId: taskId,
          beforeRevision: task.revision,
          afterRevision: fresh.task.revision,
          outcome: 'succeeded',
          reason,
          requestId: input.requestId,
          createdAt: now,
        });
        await tx.insert(idempotencyRecords).values({
          scopeHash,
          keyHash,
          requestFingerprint: fingerprint,
          status: 'completed',
          responseStatus: kind === 'saveContent' || kind === 'decideReview' ? 201 : 202,
          responseBody: response,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86400000),
        });
        return { data: response, replayed: false };
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '操作暂不可用，请使用同一动作标识重试确认。',
      );
    }
  }

  async versions(input: {
    taskId: string;
    actor: Session['member'];
    versionId?: string;
    reviewId?: string;
    kind: 'content' | 'review';
    cursor?: string;
    limit?: number;
  }) {
    await this.read(this.db, input.taskId, input.actor);
    if (input.kind === 'content') {
      if (input.versionId && !uuid.test(input.versionId))
        throw new AuthError(404, 'NOT_FOUND', '内容版本不存在。');
      const rows = await this.db
        .select()
        .from(taskContents)
        .where(
          and(
            eq(taskContents.taskId, input.taskId),
            input.versionId ? eq(taskContents.id, input.versionId) : undefined,
          ),
        )
        .orderBy(desc(taskContents.versionNo));
      if (input.versionId) {
        if (!rows[0]) throw new AuthError(404, 'NOT_FOUND', '内容版本不存在。');
        return contentModel(rows[0]);
      }
      return this.page(rows.map(contentModel), input);
    }
    if (input.reviewId && !uuid.test(input.reviewId))
      throw new AuthError(404, 'NOT_FOUND', '审核不存在。');
    const rows = await this.db
      .select()
      .from(reviewCycles)
      .where(
        and(
          eq(reviewCycles.taskId, input.taskId),
          input.reviewId ? eq(reviewCycles.id, input.reviewId) : undefined,
        ),
      )
      .orderBy(desc(reviewCycles.createdAt), desc(reviewCycles.id));
    if (input.reviewId) {
      if (!rows[0]) throw new AuthError(404, 'NOT_FOUND', '审核不存在。');
      return reviewModel(rows[0]);
    }
    return this.page(rows.map(reviewModel), input);
  }
  private page<T extends { id: string }>(
    rows: T[],
    input: { taskId: string; kind: string; cursor?: string; limit?: number },
  ) {
    let offset = 0;
    if (input.cursor) {
      try {
        const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (c.task !== input.taskId || c.kind !== input.kind || typeof c.after !== 'string')
          throw new Error();
        offset = rows.findIndex((r) => r.id === c.after) + 1;
        if (!offset) throw new Error();
      } catch {
        throw new AuthError(400, 'VALIDATION_ERROR', '分页位置无效。');
      }
    }
    const end = offset + (input.limit ?? 20),
      items = rows.slice(offset, end);
    return {
      items,
      nextCursor:
        end < rows.length
          ? Buffer.from(
              JSON.stringify({ task: input.taskId, kind: input.kind, after: items.at(-1)!.id }),
            ).toString('base64url')
          : null,
    };
  }
}
