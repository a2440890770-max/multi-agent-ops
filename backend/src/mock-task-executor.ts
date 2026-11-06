import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { draftResultSchema, reviewResultSchema } from '@multi-agent-ops/shared';
import type { DraftResult, ReviewResult, WorkflowInput } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { workflowStages } from './execution-model.js';
import {
  auditEvents,
  executionAttempts,
  executionSteps,
  reviewCycles,
  taskContents,
  tasks,
} from './schema.js';
import { basicIssues, MAX_AUTO_REVISIONS, reviewRecord } from './review-policy.js';
import { mockProvider } from './workflow-provider.js';
import type { WorkflowProvider } from './workflow-provider.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type TaskRow = typeof tasks.$inferSelect;
type AttemptRow = typeof executionAttempts.$inferSelect;
type StepRow = typeof executionSteps.$inferSelect;
type CycleRow = typeof reviewCycles.$inferSelect;
type Job = {
  task: TaskRow;
  attempt: AttemptRow | null;
  step: StepRow | null;
  cycle: CycleRow | null;
  token: string;
  input: WorkflowInput;
  mode: 'mock' | 'agent';
};
const active = ['queued', 'running'] as const;
const elapsed = (started: Date | null, now: Date) =>
  started ? Math.min(2147483647, Math.max(0, now.getTime() - started.getTime())) : null;

/** Durable, fenced workflow. Network calls run outside transactions; a lease and
 * generation comparison prevent late results from overwriting human work. */
export class MockTaskExecutor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private reportedFailure = false;
  constructor(
    private db: Database,
    private options: {
      now?: () => Date;
      pollMs?: number;
      onError?: () => void;
      provider?: WorkflowProvider;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.poll().finally(() => {
        this.running = undefined;
        this.schedule(this.options.pollMs ?? 500);
      });
    }, delay);
    this.timer.unref();
  }
  private async poll() {
    try {
      for (let i = 0; i < 20 && !this.stopped; i++) if (!(await this.tick())) break;
      this.reportedFailure = false;
    } catch {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        if (this.options.onError) this.options.onError();
        else console.error('执行器暂不可用，将从数据库检查点重试；请检查数据库和迁移状态。');
      }
    }
  }
  private async audit(
    tx: Transaction,
    task: TaskRow,
    action: string,
    now: Date,
    reason: string | null = null,
  ) {
    await tx.insert(auditEvents).values({
      teamId: task.teamId,
      taskId: task.id,
      actorType: 'worker',
      actorId: 'workflow-v2',
      action,
      targetType: 'task',
      targetId: task.id,
      beforeRevision: task.revision,
      afterRevision: task.revision + 1,
      outcome: action.endsWith('failed') ? 'failed' : 'succeeded',
      reason,
      requestId: `workflow:${task.id}:${task.revision}`,
      createdAt: now,
    });
  }
  private async taskUpdate(
    tx: Transaction,
    task: TaskRow,
    now: Date,
    values: Partial<typeof tasks.$inferInsert>,
    action: string,
  ) {
    await tx
      .update(tasks)
      .set({ ...values, revision: task.revision + 1, updatedAt: now })
      .where(eq(tasks.id, task.id));
    await this.audit(tx, task, action, now, values.errorMessage ?? null);
  }

  private async claim(): Promise<Job | boolean> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ taskId: tasks.id })
        .from(tasks)
        .leftJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
            eq(executionAttempts.generation, tasks.workGeneration),
          ),
        )
        .leftJoin(
          reviewCycles,
          and(
            eq(reviewCycles.id, tasks.currentReviewCycleId),
            eq(reviewCycles.taskId, tasks.id),
            eq(reviewCycles.generation, tasks.workGeneration),
          ),
        )
        .where(
          and(
            eq(tasks.lifecycle, 'open'),
            or(
              and(
                eq(executionAttempts.generation, tasks.workGeneration),
                inArray(executionAttempts.status, [...active]),
                lte(executionAttempts.nextRunAt, now),
              ),
              and(
                eq(reviewCycles.trigger, 'manual_submit'),
                inArray(reviewCycles.status, [...active]),
              ),
            ),
          ),
        )
        .orderBy(asc(tasks.updatedAt))
        .limit(20)
        .for('update', { of: tasks, skipLocked: true });
      for (const { taskId } of candidates) {
        // A joined discovery query may retain an older attempt snapshot when
        // PostgreSQL rechecks a concurrently updated task row. Re-read every
        // authority after holding the task lock before reserving work/budget.
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
        if (!task || task.lifecycle !== 'open') continue;
        const [attemptRow] = task.currentAttemptId
          ? await tx
              .select()
              .from(executionAttempts)
              .where(
                and(
                  eq(executionAttempts.id, task.currentAttemptId),
                  eq(executionAttempts.taskId, task.id),
                ),
              )
          : [];
        const attempt = attemptRow ?? null;
        const [cycleRow] = task.currentReviewCycleId
          ? await tx
              .select()
              .from(reviewCycles)
              .where(
                and(
                  eq(reviewCycles.id, task.currentReviewCycleId),
                  eq(reviewCycles.taskId, task.id),
                ),
              )
          : [];
        const cycle = cycleRow?.generation === task.workGeneration ? cycleRow : null;
        const manual =
          cycle?.trigger === 'manual_submit' &&
          active.includes(cycle.status as 'queued' | 'running');
        let step: StepRow | null = null;
        if (!manual) {
          if (
            !attempt ||
            attempt.generation !== task.workGeneration ||
            !active.includes(attempt.status as 'queued' | 'running') ||
            !attempt.nextRunAt ||
            attempt.nextRunAt > now ||
            attempt.cancelRequestedAt
          )
            continue;
          const steps = await tx
            .select()
            .from(executionSteps)
            .where(eq(executionSteps.attemptId, attempt.id))
            .orderBy(executionSteps.ordinal);
          if (attempt.status === 'queued') {
            const first = steps.find((step) => step.status === 'queued');
            if (!first) throw new Error('Invalid queued checkpoint');
            const currentStep = workflowStages[first.ordinal]?.label ?? '修改文案';
            await tx
              .update(executionSteps)
              .set({ status: 'running', startedAt: now })
              .where(eq(executionSteps.id, first.id));
            await tx
              .update(executionAttempts)
              .set({
                status: 'running',
                currentStep,
                startedAt: attempt.startedAt ?? now,
                nextRunAt: new Date(now.getTime() + attempt.configSnapshot.stepDelayMs),
              })
              .where(eq(executionAttempts.id, attempt.id));
            await this.taskUpdate(
              tx,
              task,
              now,
              { executionStatus: 'running', currentStep },
              'attempt.running',
            );
            return true;
          }
          step = steps.find((step) => step.status === 'running') ?? null;
          if (!step) throw new Error('Invalid running checkpoint');
          if (step.leaseExpiresAt && step.leaseExpiresAt > now) continue;
          // The previous mock executor produced its draft only after the review
          // step. Recover that durable pre-upgrade checkpoint in the same attempt.
          if (
            step.role === 'review' &&
            !cycle &&
            !task.currentContentVersionId &&
            attempt.autoRevisionCount === 0
          ) {
            const draftStep = steps.find(
              (s) => s.role === 'content' && s.ordinal === 2 && s.status === 'completed',
            );
            const [existingContent] = await tx
              .select({ id: taskContents.id })
              .from(taskContents)
              .where(eq(taskContents.originAttemptId, attempt.id))
              .limit(1);
            if (draftStep && !existingContent) {
              await tx
                .update(executionSteps)
                .set({ status: 'running', startedAt: now, finishedAt: null, durationMs: null })
                .where(eq(executionSteps.id, draftStep.id));
              await tx
                .update(executionSteps)
                .set({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null })
                .where(eq(executionSteps.id, step.id));
              await tx
                .update(executionAttempts)
                .set({
                  currentStep: '生成微博文案',
                  nextRunAt: new Date(now.getTime() + attempt.configSnapshot.stepDelayMs),
                })
                .where(eq(executionAttempts.id, attempt.id));
              await this.taskUpdate(
                tx,
                task,
                now,
                { currentStep: '生成微博文案' },
                'attempt.legacy_checkpoint_restored',
              );
              return true;
            }
          }

          if (step.role === 'supervisor' || step.role === 'research') {
            if (attempt.simulationScenario === 'failure' && step.role === 'research') {
              const error = {
                code: 'MOCK_RESEARCH_FAILED',
                message: '模拟执行失败：研究步骤返回错误，未调用真实搜索或模型。',
                retryable: true,
              };
              await tx
                .update(executionSteps)
                .set({
                  status: 'failed',
                  finishedAt: now,
                  durationMs: elapsed(step.startedAt, now),
                  error,
                })
                .where(eq(executionSteps.id, step.id));
              await tx
                .update(executionSteps)
                .set({ status: 'cancelled', finishedAt: now })
                .where(
                  and(
                    eq(executionSteps.attemptId, attempt.id),
                    eq(executionSteps.status, 'queued'),
                  ),
                );
              await tx
                .update(executionAttempts)
                .set({ status: 'failed', error, finishedAt: now, nextRunAt: null })
                .where(eq(executionAttempts.id, attempt.id));
              await this.taskUpdate(
                tx,
                task,
                now,
                { executionStatus: 'failed', errorMessage: error.message },
                'attempt.failed',
              );
              return true;
            }
            await tx
              .update(executionSteps)
              .set({
                status: 'completed',
                finishedAt: now,
                durationMs: elapsed(step.startedAt, now),
              })
              .where(eq(executionSteps.id, step.id));
            if (
              attempt.simulationScenario === 'clarification' &&
              step.role === 'supervisor' &&
              (!attempt.clarifications.length ||
                attempt.clarifications.some((q) => !q.answer?.trim()))
            ) {
              await tx
                .update(executionAttempts)
                .set({
                  status: 'awaiting_clarification',
                  currentStep: '等待澄清',
                  nextRunAt: null,
                  clarifications: [
                    {
                      questionId: randomUUID(),
                      question:
                        '【模拟澄清】请补充本次任务的明确主题、目标受众，并确认是否存在相互冲突的要求。',
                      answer: null,
                    },
                  ],
                })
                .where(eq(executionAttempts.id, attempt.id));
              await this.taskUpdate(
                tx,
                task,
                now,
                { executionStatus: 'awaiting_clarification', currentStep: '等待澄清' },
                'attempt.awaiting_clarification',
              );
            } else {
              const next = steps.find((next) => next.ordinal === step!.ordinal + 1)!;
              const currentStep = workflowStages[next.ordinal]!.label;
              await tx
                .update(executionSteps)
                .set({ status: 'running', startedAt: now })
                .where(eq(executionSteps.id, next.id));
              await tx
                .update(executionAttempts)
                .set({
                  currentStep,
                  nextRunAt: new Date(now.getTime() + attempt.configSnapshot.stepDelayMs),
                })
                .where(eq(executionAttempts.id, attempt.id));
              await this.taskUpdate(
                tx,
                task,
                now,
                { executionStatus: 'running', currentStep },
                'attempt.step_advanced',
              );
            }
            return true;
          }
        } else if (cycle!.leaseExpiresAt && cycle!.leaseExpiresAt > now) continue;
        const [content] = task.currentContentVersionId
          ? await tx
              .select()
              .from(taskContents)
              .where(
                and(
                  eq(taskContents.id, task.currentContentVersionId),
                  eq(taskContents.taskId, task.id),
                ),
              )
          : [];
        const record = cycle?.records.at(-1);
        // URLs/titles are provenance only. Only supplied request/clarification text is evidence here.
        const request = manual ? task.originalRequest : attempt!.configSnapshot.originalRequest;
        const clarified =
          attempt?.clarifications
            .filter((q) => q.answer)
            .map((q) => `${q.question}\n${q.answer}`)
            .join('\n') ?? '';
        const input: WorkflowInput = {
          role: manual ? 'review' : (step!.role as 'content' | 'review'),
          request: `${request}${clarified ? `\n澄清答复：\n${clarified}` : ''}`,
          body: content?.body ?? '',
          round: attempt?.autoRevisionCount ?? 0,
          suggestions: record
            ? [
                ...(record.suggestions ?? []),
                ...record.blockingIssues.filter((i) => !i.resolved).map((i) => i.message),
              ]
            : [],
          sources: [
            { id: task.id, text: request },
            ...(clarified ? [{ id: attempt!.id, text: clarified }] : []),
          ],
        };
        const token = randomUUID();
        const lease = { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 90000) };
        if (manual) {
          await tx
            .update(reviewCycles)
            .set({
              ...lease,
              status: 'running',
              technicalAttempts: Math.min(3, cycle!.technicalAttempts + 1),
            })
            .where(eq(reviewCycles.id, cycle!.id));
        } else {
          await tx
            .update(executionSteps)
            .set({ ...lease, technicalAttempts: Math.min(3, step!.technicalAttempts + 1) })
            .where(eq(executionSteps.id, step!.id));
        }
        if (!manual && input.role === 'review' && cycle) {
          await tx
            .update(reviewCycles)
            .set({ status: 'running', technicalAttempts: Math.min(3, step!.technicalAttempts + 1) })
            .where(eq(reviewCycles.id, cycle.id));
        }
        return {
          task,
          attempt,
          step,
          cycle,
          token,
          input,
          mode: manual ? cycle!.executorMode : attempt!.executorMode,
        };
      }
      return false;
    });
  }

  async tick(): Promise<boolean> {
    const claimed = await this.claim();
    if (typeof claimed === 'boolean') return claimed;
    const job = claimed;
    let result: DraftResult | ReviewResult | null = null;
    let failed = false;
    try {
      if ((job.step?.technicalAttempts ?? job.cycle?.technicalAttempts ?? 0) >= 3)
        throw new Error('Recovered exhausted technical attempts');
      const provider =
        job.mode === 'agent'
          ? this.options.provider
          : mockProvider(job.step ? (job.attempt?.simulationScenario ?? 'success') : 'success');
      if (!provider) throw new Error('Agent provider unavailable');
      if (job.input.role === 'content')
        result = draftResultSchema.parse(await provider.generate(job.input));
      else if (basicIssues(job.input.body).length)
        result = {
          outcome: 'changes_required',
          checks: ['基础校验不通过'],
          suggestions: ['请先修复基础校验问题。'],
          scores: [{ name: '基础校验', value: 0 }],
          blockingIssues: [],
          factualEvidenceSufficient: false,
          hasFactualClaims: false,
          facts: [],
        };
      else result = reviewResultSchema.parse(await provider.review(job.input));
    } catch {
      failed = true;
    }
    await this.commit(job, result, failed);
    return true;
  }

  private async commit(job: Job, result: DraftResult | ReviewResult | null, failed: boolean) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, job.task.id)).for('update');
      if (
        !task ||
        task.lifecycle !== 'open' ||
        task.workGeneration !== job.task.workGeneration ||
        task.currentContentVersionId !== job.task.currentContentVersionId ||
        task.currentAttemptId !== job.task.currentAttemptId ||
        task.currentReviewCycleId !== job.task.currentReviewCycleId
      )
        return;
      const manual = !job.step;
      const [checkpoint] = manual
        ? await tx.select().from(reviewCycles).where(eq(reviewCycles.id, job.cycle!.id))
        : await tx.select().from(executionSteps).where(eq(executionSteps.id, job.step!.id));
      if (!checkpoint || checkpoint.leaseToken !== job.token || checkpoint.status !== 'running')
        return;
      const attempt = job.attempt;
      const table = manual ? reviewCycles : executionSteps;
      const targetId = manual ? job.cycle!.id : job.step!.id;
      if (failed || !result) {
        const exhausted = checkpoint.technicalAttempts >= 3;
        const error = {
          code: 'WORKFLOW_CALL_FAILED',
          message: exhausted
            ? '结构化调用连续失败，请人工接管或显式新执行。'
            : '结构化调用失败，将重试当前步骤；修改轮次保持不变。',
          retryable: !exhausted,
        };
        await tx
          .update(table)
          .set({
            leaseToken: null,
            leaseExpiresAt: null,
            error,
            ...(exhausted ? { status: 'failed' as const, finishedAt: now } : {}),
          })
          .where(eq(table.id, targetId));
        if (exhausted && attempt && !manual) {
          await tx
            .update(executionAttempts)
            .set({ status: 'failed', finishedAt: now, nextRunAt: null, error })
            .where(eq(executionAttempts.id, attempt.id));
          await tx
            .update(executionSteps)
            .set({ status: 'cancelled', finishedAt: now })
            .where(
              and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'queued')),
            );
        }
        if (exhausted && job.cycle && !manual)
          await tx
            .update(reviewCycles)
            .set({ status: 'failed', finishedAt: now, error })
            .where(eq(reviewCycles.id, job.cycle.id));
        if (!exhausted && attempt && !manual)
          await tx
            .update(executionAttempts)
            .set({ nextRunAt: new Date(now.getTime() + 1000) })
            .where(eq(executionAttempts.id, attempt.id));
        await this.taskUpdate(
          tx,
          task,
          now,
          {
            executionStatus: exhausted ? (manual ? 'needs_human' : 'failed') : 'running',
            errorMessage: error.message,
          },
          exhausted ? 'workflow.failed' : 'workflow.technical_retry',
        );
        return;
      }
      if (job.step)
        await tx
          .update(executionSteps)
          .set({
            status: 'completed',
            leaseToken: null,
            leaseExpiresAt: null,
            error: null,
            finishedAt: now,
            durationMs: elapsed(job.step.startedAt, now),
          })
          .where(eq(executionSteps.id, job.step.id));
      if (job.input.role === 'content') {
        if (!attempt || !job.step) throw new Error('Missing attempt');
        const [count] = await tx
          .select({ max: sql<number>`coalesce(max(${taskContents.versionNo}),0)::integer` })
          .from(taskContents)
          .where(eq(taskContents.taskId, task.id));
        const body = (result as DraftResult).body;
        const [content] = await tx
          .insert(taskContents)
          .values({
            taskId: task.id,
            originAttemptId: attempt.id,
            parentVersionId: task.currentContentVersionId,
            versionNo: (count?.max ?? 0) + 1,
            sourceKind: 'agent',
            revisionRound: attempt.autoRevisionCount,
            body,
            contentHash: createHash('sha256').update(body).digest('hex'),
            createdBy: attempt.requestedBy,
            createdAt: now,
          })
          .returning();
        const [cycle] = await tx
          .insert(reviewCycles)
          .values({
            taskId: task.id,
            attemptId: attempt.id,
            trigger: 'initial_generation',
            inputVersionId: content!.id,
            currentVersionId: content!.id,
            status: 'queued',
            requestedBy: attempt.requestedBy,
            generation: task.workGeneration,
            executorMode: attempt.executorMode,
            createdAt: now,
          })
          .returning();
        await tx
          .update(executionSteps)
          .set({ outputContentId: content!.id })
          .where(eq(executionSteps.id, job.step.id));
        await tx
          .update(executionSteps)
          .set({ status: 'running', startedAt: now })
          .where(
            and(
              eq(executionSteps.attemptId, attempt.id),
              eq(executionSteps.ordinal, job.step.ordinal + 1),
            ),
          );
        await tx
          .update(executionAttempts)
          .set({
            currentStep: '审核当前文案',
            nextRunAt: new Date(now.getTime() + attempt.configSnapshot.stepDelayMs),
          })
          .where(eq(executionAttempts.id, attempt.id));
        await this.taskUpdate(
          tx,
          task,
          now,
          {
            currentContentVersionId: content!.id,
            currentReviewCycleId: cycle!.id,
            currentStep: '审核当前文案',
          },
          'content.generated',
        );
        return;
      }
      if (!job.cycle || !task.currentContentVersionId) throw new Error('Missing review cycle');
      const record = reviewRecord(
        job.cycle.id,
        task.currentContentVersionId,
        job.input,
        result as ReviewResult,
        now,
      );
      if (job.mode === 'mock' || basicIssues(job.input.body).length)
        record.scores = record.scores.map((s) => ({ ...s, source: 'rule' }));
      await tx
        .update(reviewCycles)
        .set({
          status: 'completed',
          records: [record],
          finishedAt: now,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(reviewCycles.id, job.cycle.id));
      if (
        !manual &&
        attempt &&
        record.outcome !== 'pass' &&
        record.outcome !== 'manual_required' &&
        attempt.autoRevisionCount < MAX_AUTO_REVISIONS
      ) {
        // Reserve the next revision atomically with its rejected Review; retries never touch this counter.
        const round = attempt.autoRevisionCount + 1;
        const ordinal = job.step!.ordinal + 1;
        await tx.insert(executionSteps).values([
          { attemptId: attempt.id, ordinal, role: 'content', status: 'running', startedAt: now },
          { attemptId: attempt.id, ordinal: ordinal + 1, role: 'review', status: 'queued' },
        ]);
        await tx
          .update(executionAttempts)
          .set({
            autoRevisionCount: round,
            currentStep: `自动修改第 ${round} 轮`,
            nextRunAt: new Date(now.getTime() + attempt.configSnapshot.stepDelayMs),
          })
          .where(eq(executionAttempts.id, attempt.id));
        await this.taskUpdate(
          tx,
          task,
          now,
          { currentStep: `自动修改第 ${round} 轮`, errorMessage: null },
          'review.revision_reserved',
        );
      } else {
        const passed = record.outcome === 'pass';
        const status = passed ? 'ready' : 'manual_required';
        const currentStep = passed ? '审核通过，等待人工处理' : '待人工处理';
        if (!manual && attempt)
          await tx
            .update(executionAttempts)
            .set({ status, currentStep, finishedAt: now, nextRunAt: null })
            .where(eq(executionAttempts.id, attempt.id));
        await this.taskUpdate(
          tx,
          task,
          now,
          {
            executionStatus: passed ? 'ready' : 'needs_human',
            currentStep,
            errorMessage: passed
              ? null
              : '审核未通过；自动流程已停止，请人工编辑重审、裁决或调整要求新执行。',
          },
          passed ? 'attempt.ready' : 'review.manual_required',
        );
      }
    });
  }
}
