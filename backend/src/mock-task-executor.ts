import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Failure } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { mockStages } from './execution-model.js';
import { readExecutorPolicy, type ExecutorPolicy } from './execution-config.js';
import {
  admitControlledCall,
  classifyStepError,
  endControlledAttempt,
  ensureControlPolicy,
  expireControlledAttempts,
  finishControlledCall,
  pauseActiveTime,
  simulationReservation,
  type CallReservation,
  type StepResult,
} from './execution-control.js';
import {
  executionNow,
  recoverInterruptedExecutions,
  recoverInterruptedPublications,
  type ExecutionTransaction,
} from './execution-ownership.js';
import { auditEvents, executionAttempts, executionSteps, taskContents, tasks } from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
type Job = { task: typeof tasks.$inferSelect; attempt: typeof executionAttempts.$inferSelect };
export interface MockStepInput {
  taskId: string;
  attemptId: string;
  role: string;
  signal: AbortSignal;
  callId: string;
  retryNo: number;
  maxTokens: number;
  maxCostMicrosCny: number;
}
interface Options extends Partial<ExecutorPolicy> {
  now?: () => Date;
  onError?: () => void;
  enabled?: boolean;
  /** A controllable read/generate-only adapter for integration tests; never a publisher. */
  runStep?: (input: MockStepInput) => Promise<StepResult | void>;
  reservation?: CallReservation;
}
const duration = (started: Date | null, now: Date) =>
  started ? Math.min(2147483647, Math.max(0, now.getTime() - started.getTime())) : null;

/** Database admission and result commits are short transactions. Work between them
 * holds a persistent lease, never a database lock. No live platform/model is wired here. */
export class MockTaskExecutor {
  readonly executorId = randomUUID();
  readonly policy: ExecutorPolicy;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatWork: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private closing = false;
  private reportedFailure = false;
  private preparing: Promise<void> = Promise.resolve();
  private inFlight = new Map<string, AbortController>();
  private abandoned = new Set<string>();
  constructor(
    private db: Database,
    private options: Options = {},
  ) {
    const defaults = readExecutorPolicy({});
    this.policy = readExecutorPolicy({
      TASK_EXECUTOR_POLL_MS: String(options.pollMs ?? defaults.pollMs),
      TASK_EXECUTOR_HEARTBEAT_MS: String(options.heartbeatMs ?? defaults.heartbeatMs),
      TASK_EXECUTOR_LEASE_MS: String(options.leaseMs ?? defaults.leaseMs),
      TASK_EXECUTOR_CONCURRENCY: String(options.concurrency ?? defaults.concurrency),
    });
  }
  start() {
    if (!this.stopped) return;
    this.closing = false;
    this.stopped = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatWork) return;
      this.heartbeatWork = this.heartbeat()
        .then(() => undefined)
        .catch(() => {
          for (const [id, controller] of this.inFlight) {
            this.abandoned.add(id);
            controller.abort();
          }
          this.reportError();
        })
        .finally(() => {
          this.heartbeatWork = undefined;
        });
    }, this.policy.heartbeatMs);
    this.heartbeatTimer.unref();
    this.schedule(0);
  }
  async stop() {
    this.closing = true;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.inFlight.values()) controller.abort();
    await this.running;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeatWork;
    // Graceful shutdown fences unfinished work immediately; killed processes are
    // handled by the same recovery after the persisted lease expires.
    await this.db
      .update(executionAttempts)
      .set({ leaseExpiresAt: executionAttempts.heartbeatAt })
      .where(
        and(
          eq(executionAttempts.executorId, this.executorId),
          eq(executionAttempts.status, 'running'),
        ),
      );
    await recoverInterruptedExecutions(this.db, this.options.now);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.poll().finally(() => {
        this.running = undefined;
        this.schedule(this.policy.pollMs);
      });
    }, delay);
    this.timer.unref();
  }
  private reportError() {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    if (this.options.onError) this.options.onError();
    else console.error('后台执行暂不可用；请检查数据库和迁移状态，遗留执行将按租约识别。');
  }
  private async poll() {
    try {
      for (let i = 0; i < 20 && !this.stopped; i++) {
        const results = await Promise.allSettled(
          Array.from({ length: this.policy.concurrency }, () => this.tick()),
        );
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (!results.some((result) => result.status === 'fulfilled' && result.value)) break;
      }
      this.reportedFailure = false;
    } catch {
      this.reportError();
    }
  }
  async heartbeat() {
    const renewed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      const clock = this.options.now
        ? sql`${this.options.now()}::timestamptz`
        : sql`clock_timestamp()`;
      return tx
        .update(executionAttempts)
        .set({
          heartbeatAt: clock,
          leaseExpiresAt: sql`${clock} + ${this.policy.leaseMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(executionAttempts.executorId, this.executorId),
            eq(executionAttempts.status, 'running'),
            sql`${executionAttempts.leaseExpiresAt} > ${clock}`,
            isNull(executionAttempts.cancelRequestedAt),
            this.abandoned.size ? notInArray(executionAttempts.id, [...this.abandoned]) : undefined,
            sql`EXISTS (SELECT 1 FROM tasks t WHERE t.id=${executionAttempts.taskId} AND t.current_attempt_id=${executionAttempts.id} AND t.work_generation=${executionAttempts.generation} AND t.lifecycle='open')`,
          ),
        )
        .returning({ id: executionAttempts.id });
    });
    const valid = new Set(renewed.map((row) => row.id));
    for (const [id, controller] of this.inFlight)
      if (!valid.has(id)) {
        this.abandoned.add(id);
        controller.abort();
      }
    return renewed.length;
  }
  private async prepare(): Promise<{ changed: boolean; job?: Job }> {
    if (this.closing) return { changed: false };
    const recovered = await recoverInterruptedExecutions(this.db, this.options.now);
    const expired = await expireControlledAttempts(this.db, this.options.now);
    const publications = await recoverInterruptedPublications(
      this.db,
      this.policy.leaseMs,
      this.options.now,
    );
    if (this.options.enabled === false) return { changed: recovered + expired + publications > 0 };
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const now = await executionNow(tx, this.options.now);
      const owned = await tx
        .select({ id: executionAttempts.id })
        .from(executionAttempts)
        .where(
          and(
            eq(executionAttempts.executorId, this.executorId),
            eq(executionAttempts.status, 'running'),
            gt(executionAttempts.leaseExpiresAt, now),
          ),
        );
      const available = owned.length < this.policy.concurrency;
      const [job] = await tx
        .select({ task: tasks, attempt: executionAttempts })
        .from(tasks)
        .innerJoin(
          executionAttempts,
          and(
            eq(executionAttempts.id, tasks.currentAttemptId),
            eq(executionAttempts.taskId, tasks.id),
            eq(executionAttempts.generation, tasks.workGeneration),
          ),
        )
        .where(
          and(
            eq(tasks.lifecycle, 'open'),
            isNull(tasks.activePublishOperationId),
            isNull(tasks.publishedOperationId),
            eq(executionAttempts.executorMode, 'mock'),
            isNull(executionAttempts.cancelRequestedAt),
            lte(executionAttempts.nextRunAt, now),
            sql`NOT EXISTS (SELECT 1 FROM task_review_cycles r WHERE r.task_id=${tasks.id} AND r.data->>'status' IN ('queued','running'))`,
            or(
              and(
                eq(executionAttempts.status, 'running'),
                eq(executionAttempts.executorId, this.executorId),
                gt(executionAttempts.leaseExpiresAt, now),
              ),
              available
                ? and(eq(executionAttempts.status, 'queued'), isNull(executionAttempts.executorId))
                : sql`false`,
            ),
            this.inFlight.size
              ? notInArray(executionAttempts.id, [...this.inFlight.keys()])
              : undefined,
            this.abandoned.size ? notInArray(executionAttempts.id, [...this.abandoned]) : undefined,
          ),
        )
        .orderBy(asc(executionAttempts.nextRunAt), asc(executionAttempts.id))
        .limit(1)
        .for('update', { of: [tasks, executionAttempts], skipLocked: true });
      if (!job) return { changed: recovered + expired + publications > 0 };
      if (job.attempt.status === 'queued') {
        await ensureControlPolicy(tx, job, now);
        const token = randomUUID();
        await tx
          .update(executionAttempts)
          .set({
            executorId: this.executorId,
            claimToken: token,
            claimedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + this.policy.leaseMs),
            runtimePolicy: this.policy,
          })
          .where(eq(executionAttempts.id, job.attempt.id));
        await tx.insert(auditEvents).values({
          teamId: job.task.teamId,
          taskId: job.task.id,
          actorType: 'worker',
          actorId: this.executorId,
          action: 'attempt.claimed',
          targetType: 'execution_attempt',
          targetId: job.attempt.id,
          outcome: 'succeeded',
          requestId: `claim:${token}`,
          createdAt: now,
        });
        await this.transition(tx, job, now);
        return { changed: true };
      }
      return { changed: true, job };
    });
  }
  private async current(tx: ExecutionTransaction, job: Job) {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, job.task.id)).for('update');
    const [attempt] = await tx
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.id, job.attempt.id))
      .for('update');
    const now = await executionNow(tx, this.options.now);
    if (
      !task ||
      !attempt ||
      task.lifecycle !== 'open' ||
      task.activePublishOperationId ||
      task.publishedOperationId ||
      task.currentAttemptId !== attempt.id ||
      task.workGeneration !== attempt.generation ||
      attempt.status !== 'running' ||
      attempt.cancelRequestedAt ||
      attempt.executorId !== this.executorId ||
      attempt.claimToken !== job.attempt.claimToken ||
      !attempt.leaseExpiresAt ||
      attempt.leaseExpiresAt <= now
    )
      return;
    return { task, attempt, now };
  }
  /** One durable transition, also used by deterministic integration tests. */
  async tick(): Promise<boolean> {
    const previous = this.preparing;
    let release!: () => void;
    this.preparing = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let prepared: Awaited<ReturnType<MockTaskExecutor['prepare']>>;
    const controller = new AbortController();
    try {
      prepared = await this.prepare();
      if (prepared.job) this.inFlight.set(prepared.job.attempt.id, controller);
    } finally {
      release();
    }
    const job = prepared.job;
    if (!job) return prepared.changed;
    if (this.closing) controller.abort();
    try {
      const reservation = this.options.reservation ?? simulationReservation;
      const admission = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        const current = await this.current(tx, job);
        if (!current || controller.signal.aborted) return {};
        const admitted = await admitControlledCall(tx, current, current.now, reservation);
        if (admitted.failure)
          await endControlledAttempt(tx, current, current.now, admitted.failure);
        return admitted;
      });
      if (!admission.call) return !!admission.failure;
      const call = admission.call;
      const [step] = await this.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.id, call.stepId));
      if (!step || controller.signal.aborted) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const now = await executionNow(this.db, this.options.now);
      const remainingMs = call.deadlineAt.getTime() - now.getTime();
      type Outcome =
        | { kind: 'done'; result: StepResult | void }
        | { kind: 'error'; error: unknown }
        | { kind: 'timeout' }
        | { kind: 'aborted' };
      let outcome: Outcome;
      try {
        if (remainingMs <= 0) outcome = { kind: 'timeout' };
        else {
          const work: Promise<Outcome> = Promise.resolve()
            .then(async () => {
              if (controller.signal.aborted) return { kind: 'aborted' as const };
              const result = this.options.runStep
                ? await this.options.runStep({
                    taskId: job.task.id,
                    attemptId: job.attempt.id,
                    role: step.role,
                    signal: controller.signal,
                    callId: call.id,
                    retryNo: call.retryNo,
                    maxTokens: reservation.maxTokens,
                    maxCostMicrosCny: reservation.maxCostMicrosCny,
                  })
                : undefined;
              return { kind: 'done' as const, result };
            })
            .catch((error: unknown) => ({ kind: 'error' as const, error }));
          outcome = await Promise.race([
            work,
            new Promise<Outcome>((resolve) => {
              timer = setTimeout(() => {
                resolve({ kind: 'timeout' });
                controller.abort();
              }, remainingMs);
            }),
            new Promise<Outcome>((resolve) => {
              abortListener = () => resolve({ kind: 'aborted' });
              controller.signal.addEventListener('abort', abortListener, { once: true });
              if (controller.signal.aborted) abortListener();
            }),
          ]);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      }
      if (outcome.kind === 'aborted') return false;
      const classified = outcome.kind === 'error' ? classifyStepError(outcome.error) : undefined;
      const mockFailure =
        !this.options.runStep &&
        job.attempt.simulationScenario === 'failure' &&
        step.role === 'research'
          ? {
              code: 'MOCK_RESEARCH_FAILED',
              message: '模拟执行失败：研究步骤按所选验证情形返回错误，未调用真实搜索或模型。',
              retryable: true,
            }
          : undefined;
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        const current = await this.current(tx, job);
        if (!current) return false;
        const action = await finishControlledCall(tx, current, call, current.now, {
          result: outcome.kind === 'done' ? outcome.result : undefined,
          failure: classified?.failure ?? mockFailure,
          canRetry: classified?.canRetry,
          timedOut: outcome.kind === 'timeout',
        });
        if (action === 'advance') await this.transition(tx, current, current.now);
        return action !== 'ignored';
      });
    } catch (error) {
      // Never automatically invoke the same external step after an uncertain commit.
      this.abandoned.add(job.attempt.id);
      throw error;
    } finally {
      this.inFlight.delete(job.attempt.id);
    }
  }
  private async transition(tx: ExecutionTransaction, job: Job, now: Date) {
    const { task, attempt } = job;
    if (attempt.executorMode !== 'mock' || attempt.configSnapshot.mode !== 'mock')
      throw new Error('模拟执行器不能处理真实 Agent 配置。');
    const snapshot = attempt.configSnapshot;
    const steps = await tx
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.attemptId, attempt.id))
      .orderBy(executionSteps.ordinal);
    const nextDue = new Date(now.getTime() + snapshot.stepDelayMs);
    let status: typeof attempt.status = 'running';
    let currentStep: string;
    let error: Failure | null = null;
    let contentId: string | null = null;
    let action: string;
    if (attempt.status === 'queued') {
      const first = steps.find((step) => step.status === 'queued');
      if (!first || first.status !== 'queued') throw new Error('invalid mock checkpoint');
      currentStep = mockStages[first.ordinal]!.label;
      action = 'attempt.running';
      await tx
        .update(executionSteps)
        .set({ status: 'running', startedAt: now })
        .where(eq(executionSteps.id, first.id));
      await tx
        .update(executionAttempts)
        .set({ status, currentStep, startedAt: attempt.startedAt ?? now, nextRunAt: nextDue })
        .where(eq(executionAttempts.id, attempt.id));
    } else {
      const current = steps.find((step) => step.status === 'running');
      if (!current) throw new Error('invalid mock checkpoint');
      const failure = attempt.simulationScenario === 'failure' && current.role === 'research';
      const clarification =
        attempt.simulationScenario === 'clarification' &&
        current.role === 'supervisor' &&
        (!attempt.clarifications.length ||
          attempt.clarifications.some((question) => !question.answer?.trim()));
      if (failure) {
        status = 'failed';
        currentStep = '模拟研究资料';
        error = {
          code: 'MOCK_RESEARCH_FAILED',
          message: '模拟执行失败：研究步骤按所选验证情形返回错误，未调用真实搜索或模型。',
          retryable: true,
        };
        action = 'attempt.failed';
        await tx
          .update(executionSteps)
          .set({
            status: 'failed',
            finishedAt: now,
            durationMs: duration(current.startedAt, now),
            error,
          })
          .where(eq(executionSteps.id, current.id));
        await tx
          .update(executionSteps)
          .set({ status: 'cancelled', finishedAt: now })
          .where(
            and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'queued')),
          );
        await tx
          .update(executionAttempts)
          .set({ status, currentStep, error, finishedAt: now, nextRunAt: null })
          .where(eq(executionAttempts.id, attempt.id));
      } else {
        await tx
          .update(executionSteps)
          .set({
            status: 'completed',
            finishedAt: now,
            durationMs: duration(current.startedAt, now),
          })
          .where(eq(executionSteps.id, current.id));
        if (clarification) {
          status = 'awaiting_clarification';
          currentStep = '等待澄清';
          action = 'attempt.awaiting_clarification';
          await tx
            .update(executionAttempts)
            .set({
              status,
              currentStep,
              nextRunAt: null,
              executorId: null,
              claimToken: null,
              claimedAt: null,
              heartbeatAt: null,
              leaseExpiresAt: null,
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
        } else {
          const next = steps[current.ordinal + 1];
          if (next) {
            if (next.status !== 'queued') throw new Error('invalid next mock step');
            currentStep = mockStages[next.ordinal]!.label;
            action = 'attempt.step_advanced';
            await tx
              .update(executionSteps)
              .set({ status: 'running', startedAt: now })
              .where(eq(executionSteps.id, next.id));
            await tx
              .update(executionAttempts)
              .set({ currentStep, nextRunAt: nextDue })
              .where(eq(executionAttempts.id, attempt.id));
          } else {
            status = 'ready';
            currentStep = '模拟执行完成';
            action = 'attempt.ready';
            const [count] = await tx
              .select({ max: sql<number>`coalesce(max(${taskContents.versionNo}), 0)::integer` })
              .from(taskContents)
              .where(eq(taskContents.taskId, task.id));
            const clarified = attempt.clarifications
              .filter((entry) => entry.answer !== null)
              .map((entry) => `问题：${entry.question}\n答复：${entry.answer}`)
              .join('\n\n');
            const body = `【模拟产出，仅用于流程验证，不代表真实研究或审核结果】\n\n原始要求：\n${snapshot.originalRequest}${clarified ? `\n\n已保存的澄清答复：\n${clarified}` : ''}\n\n模拟执行已完成；真实文案生成将在后续接入。`;
            const [content] = await tx
              .insert(taskContents)
              .values({
                taskId: task.id,
                originAttemptId: attempt.id,
                versionNo: (count?.max ?? 0) + 1,
                parentVersionId:
                  (
                    await tx
                      .select({ id: taskContents.id })
                      .from(taskContents)
                      .where(eq(taskContents.taskId, task.id))
                      .orderBy(desc(taskContents.versionNo))
                      .limit(1)
                  )[0]?.id ?? null,
                body,
                contentHash: createHash('sha256').update(body).digest('hex'),
                createdBy: attempt.requestedBy,
                createdAt: now,
              })
              .returning();
            if (!content) throw new Error('mock output insert failed');
            contentId = content.id;
            await tx
              .update(executionAttempts)
              .set({ status, currentStep, finishedAt: now, nextRunAt: null })
              .where(eq(executionAttempts.id, attempt.id));
          }
        }
      }
    }
    if (status !== 'running') await pauseActiveTime(tx, attempt, now);
    await tx
      .update(tasks)
      .set({
        executionStatus: status,
        currentStep,
        errorMessage: error?.message ?? null,
        currentContentVersionId: contentId,
        revision: task.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.currentAttemptId, attempt.id),
          eq(tasks.workGeneration, attempt.generation),
        ),
      );
    await tx.insert(auditEvents).values({
      teamId: task.teamId,
      taskId: task.id,
      actorType: 'worker',
      actorId: this.executorId,
      action,
      targetType: 'execution_attempt',
      targetId: attempt.id,
      beforeRevision: task.revision,
      afterRevision: task.revision + 1,
      outcome: failureOutcome(status),
      reason: error?.message ?? null,
      requestId: `mock:${attempt.id}:${task.revision}`,
      createdAt: now,
    });
  }
}
const failureOutcome = (status: string) =>
  status === 'failed' ? ('failed' as const) : ('succeeded' as const);
