import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Failure } from '@multi-agent-ops/shared';
import type { createBusinessDatabase } from './database.js';
import { executionNow, type ExecutionTransaction } from './execution-ownership.js';
import { readExecutionLimits } from './execution-config.js';
import {
  auditEvents,
  executionAttempts,
  executionBudgets,
  executionCalls,
  executionSteps,
  tasks,
} from './schema.js';

type Database = ReturnType<typeof createBusinessDatabase>['db'];
export type ControlJob = {
  task: typeof tasks.$inferSelect;
  attempt: typeof executionAttempts.$inferSelect;
};
type Step = typeof executionSteps.$inferSelect;
type Call = typeof executionCalls.$inferSelect;
export interface CallReservation {
  kind: 'simulation' | 'model' | 'search' | 'readonly';
  maxTokens: number;
  maxCostMicrosCny: number;
  /** Version of the configured prices used to calculate the request's upper bound. */
  pricingRef: string;
}
export interface StepResult {
  usage?: { tokens?: number; estimatedCostMicrosCny?: number };
}
export const simulationReservation: CallReservation = {
  kind: 'simulation',
  maxTokens: 0,
  maxCostMicrosCny: 0,
  pricingRef: 'simulation:free:v1',
};
const transientCodes = ['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'NETWORK_ERROR'] as const;
export class TechnicalStepError extends Error {
  constructor(readonly code: (typeof transientCodes)[number]) {
    super(code);
  }
}
export function classifyStepError(error: unknown): { failure: Failure; canRetry: boolean } {
  if (error instanceof TechnicalStepError && transientCodes.includes(error.code))
    return {
      failure: { code: error.code, message: '模型或只读工具发生临时技术故障。', retryable: true },
      canRetry: true,
    };
  return {
    failure: {
      code: 'EXECUTION_STEP_FAILED',
      message: '执行步骤调用失败，请查看尝试记录并人工重试。',
      retryable: false,
    },
    canRetry: false,
  };
}
const problem = (code: string, message: string, retryable = false): Failure => ({
  code,
  message,
  retryable,
});
export function activeDuration(attempt: ControlJob['attempt'], now: Date) {
  return Math.min(
    2147483647,
    attempt.activeElapsedMs +
      (attempt.activeSince ? Math.max(0, now.getTime() - attempt.activeSince.getTime()) : 0),
  );
}
export async function pauseActiveTime(
  tx: ExecutionTransaction,
  attempt: ControlJob['attempt'],
  now: Date,
) {
  await tx
    .update(executionAttempts)
    .set({ activeElapsedMs: activeDuration(attempt, now), activeSince: null })
    .where(eq(executionAttempts.id, attempt.id));
}
export async function interruptCalls(
  tx: ExecutionTransaction,
  attemptId: string,
  now: Date,
  error: Failure | null,
) {
  // Reservations are already included in the task ledger. Unknown usage is never refunded.
  await tx
    .update(executionCalls)
    .set({ status: 'interrupted', finishedAt: now, error })
    .where(and(eq(executionCalls.attemptId, attemptId), eq(executionCalls.status, 'running')));
}
export async function endControlledAttempt(
  tx: ExecutionTransaction,
  job: ControlJob,
  now: Date,
  error: Failure,
) {
  const { task, attempt } = job;
  await interruptCalls(tx, attempt.id, now, error);
  await tx
    .update(executionSteps)
    .set({
      status: 'failed',
      error,
      finishedAt: now,
      nextCallAt: null,
      durationMs: sql`greatest(0, least(2147483647, floor(extract(epoch FROM (${now}::timestamptz - ${executionSteps.startedAt})) * 1000)))::integer`,
    })
    .where(and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'running')));
  await tx
    .update(executionSteps)
    .set({ status: 'cancelled', finishedAt: now, nextCallAt: null })
    .where(and(eq(executionSteps.attemptId, attempt.id), eq(executionSteps.status, 'queued')));
  await tx
    .update(executionAttempts)
    .set({
      status: 'failed',
      error,
      finishedAt: now,
      nextRunAt: null,
      activeElapsedMs: activeDuration(attempt, now),
      activeSince: null,
    })
    .where(eq(executionAttempts.id, attempt.id));
  await tx
    .update(tasks)
    .set({
      executionStatus: 'failed',
      errorMessage: error.message,
      workGeneration: task.workGeneration + 1,
      revision: task.revision + 1,
      updatedAt: now,
    })
    .where(eq(tasks.id, task.id));
  await tx.insert(auditEvents).values({
    teamId: task.teamId,
    taskId: task.id,
    actorType: 'system',
    actorId: 'execution-control',
    action: 'attempt.failed',
    targetType: 'execution_attempt',
    targetId: attempt.id,
    beforeRevision: task.revision,
    afterRevision: task.revision + 1,
    outcome: 'failed',
    reason: error.message,
    requestId: `control:${attempt.id}:${task.revision}`,
    createdAt: now,
  });
}
export function timeFailure(
  attempt: ControlJob['attempt'],
  step: Step,
  now: Date,
): Failure | undefined {
  const limits = attempt.executionLimits;
  if (!limits) return;
  if (activeDuration(attempt, now) >= limits.attemptTimeoutMs)
    return problem('EXECUTION_ATTEMPT_TIMEOUT', '本次执行累计时长超限；不包含排队和等待澄清时间。');
  if (step.startedAt && now.getTime() - step.startedAt.getTime() >= limits.stepTimeoutMs)
    return problem('EXECUTION_STEP_TIMEOUT', '步骤累计执行超时，已停止后续调度。');
}
export async function ensureControlPolicy(tx: ExecutionTransaction, job: ControlJob, now: Date) {
  const limits = job.attempt.executionLimits ?? readExecutionLimits({});
  if (!job.attempt.executionLimits)
    await tx
      .update(executionAttempts)
      .set({ executionLimits: limits })
      .where(eq(executionAttempts.id, job.attempt.id));
  await tx.insert(executionBudgets).values({ taskId: job.task.id, limits }).onConflictDoNothing();
  await tx
    .update(executionAttempts)
    .set({ activeSince: now })
    .where(eq(executionAttempts.id, job.attempt.id));
}
function validQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
  );
}
function reservationFailure(value: CallReservation): Failure | undefined {
  if (
    !['simulation', 'model', 'search', 'readonly'].includes(value.kind) ||
    !validQuantity(value.maxTokens) ||
    !validQuantity(value.maxCostMicrosCny) ||
    !value.pricingRef?.trim() ||
    value.pricingRef.length > 200 ||
    (value.kind === 'model' && value.maxTokens < 1)
  )
    return problem(
      'EXECUTION_PRICING_UNCONFIGURED',
      '调用缺少有效的用量上界或计价版本，未发起请求。',
    );
}
function budgetFailure(
  budget: typeof executionBudgets.$inferSelect,
  extraCalls: number,
  tokens: number,
  cost: number,
): Failure | undefined {
  if (budget.calls + extraCalls > budget.limits.maxCalls)
    return problem(
      'EXECUTION_BUDGET_CALLS_EXCEEDED',
      '任务累计调用次数超限，包含所有尝试和技术重试。',
    );
  if (budget.chargedTokens + tokens > budget.limits.maxTokens)
    return problem(
      'EXECUTION_BUDGET_TOKENS_EXCEEDED',
      '任务累计 Token 预算不足，已包含未知用量的预占额度。',
    );
  if (budget.chargedCostMicrosCny + cost > budget.limits.maxCostMicrosCny)
    return problem('EXECUTION_BUDGET_COST_EXCEEDED', '任务累计估算费用预算不足，已停止后续调用。');
}
export async function admitControlledCall(
  tx: ExecutionTransaction,
  job: ControlJob,
  now: Date,
  reservation: CallReservation,
): Promise<{ call?: Call; failure?: Failure }> {
  const [step] = await tx
    .select()
    .from(executionSteps)
    .where(and(eq(executionSteps.attemptId, job.attempt.id), eq(executionSteps.status, 'running')))
    .for('update');
  if (!step || (step.nextCallAt && step.nextCallAt > now)) return {};
  const failure = timeFailure(job.attempt, step, now) ?? reservationFailure(reservation);
  if (failure) return { failure };
  const [last] = await tx
    .select()
    .from(executionCalls)
    .where(eq(executionCalls.stepId, step.id))
    .orderBy(desc(executionCalls.callNo))
    .limit(1);
  if (last?.status === 'running' || last?.status === 'succeeded') return {};
  const [budget] = await tx
    .select()
    .from(executionBudgets)
    .where(eq(executionBudgets.taskId, job.task.id))
    .for('update');
  if (!budget) throw new Error('execution budget is missing');
  const exceeded = budgetFailure(budget, 1, reservation.maxTokens, reservation.maxCostMicrosCny);
  if (exceeded) return { failure: exceeded };
  await tx.update(executionSteps).set({ nextCallAt: null }).where(eq(executionSteps.id, step.id));
  const limits = job.attempt.executionLimits!;
  const deadline = Math.min(
    now.getTime() + limits.callTimeoutMs,
    step.startedAt!.getTime() + limits.stepTimeoutMs,
    now.getTime() + limits.attemptTimeoutMs - activeDuration(job.attempt, now),
  );
  const [call] = await tx
    .insert(executionCalls)
    .values({
      taskId: job.task.id,
      attemptId: job.attempt.id,
      stepId: step.id,
      callNo: (last?.callNo ?? 0) + 1,
      retryNo: step.retryCount,
      kind: reservation.kind,
      status: 'running',
      pricingRef: reservation.pricingRef,
      reservedTokens: reservation.maxTokens,
      reservedCostMicrosCny: reservation.maxCostMicrosCny,
      chargedTokens: reservation.maxTokens,
      chargedCostMicrosCny: reservation.maxCostMicrosCny,
      startedAt: now,
      deadlineAt: new Date(deadline),
    })
    .returning();
  if (!call) throw new Error('call admission failed');
  await tx
    .update(executionBudgets)
    .set({
      calls: budget.calls + 1,
      chargedTokens: budget.chargedTokens + reservation.maxTokens,
      chargedCostMicrosCny: budget.chargedCostMicrosCny + reservation.maxCostMicrosCny,
    })
    .where(eq(executionBudgets.taskId, job.task.id));
  await tx.insert(auditEvents).values({
    teamId: job.task.teamId,
    taskId: job.task.id,
    actorType: 'worker',
    actorId: job.attempt.executorId,
    action: 'execution.call_started',
    targetType: 'execution_call',
    targetId: call.id,
    outcome: 'succeeded',
    requestId: `call:${call.id}`,
    createdAt: now,
  });
  return { call };
}
export async function finishControlledCall(
  tx: ExecutionTransaction,
  job: ControlJob,
  original: Call,
  now: Date,
  outcome: {
    result?: StepResult | void;
    failure?: Failure | undefined;
    canRetry?: boolean | undefined;
    timedOut?: boolean;
  },
): Promise<'advance' | 'retry' | 'failed' | 'ignored'> {
  const [call] = await tx
    .select()
    .from(executionCalls)
    .where(eq(executionCalls.id, original.id))
    .for('update');
  const [step] = await tx
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.id, original.stepId))
    .for('update');
  if (!call || call.status !== 'running' || !step || step.status !== 'running') return 'ignored';
  const timeError = timeFailure(job.attempt, step, now);
  let error = timeError ?? outcome.failure;
  const timedOut = outcome.timedOut || now >= call.deadlineAt;
  if (!timeError && timedOut)
    error = problem('EXECUTION_CALL_TIMEOUT', '单次调用超过允许时长，迟到结果不再采用。', true);
  const usage = !timedOut ? outcome.result?.usage : undefined;
  const freeSimulation = call.kind === 'simulation' && !outcome.failure && !timedOut;
  const tokensKnown = usage?.tokens !== undefined || freeSimulation;
  const costKnown = usage?.estimatedCostMicrosCny !== undefined || freeSimulation;
  const tokens = tokensKnown ? (usage?.tokens ?? 0) : call.reservedTokens;
  const cost = costKnown ? (usage?.estimatedCostMicrosCny ?? 0) : call.reservedCostMicrosCny;
  const validUsage = validQuantity(tokens) && validQuantity(cost);
  const chargedTokens = validUsage ? tokens : call.reservedTokens;
  const chargedCost = validUsage ? cost : call.reservedCostMicrosCny;
  const [budget] = await tx
    .select()
    .from(executionBudgets)
    .where(eq(executionBudgets.taskId, job.task.id))
    .for('update');
  if (!budget) throw new Error('execution budget is missing');
  const updatedBudget = {
    ...budget,
    chargedTokens: budget.chargedTokens + chargedTokens - call.chargedTokens,
    chargedCostMicrosCny: budget.chargedCostMicrosCny + chargedCost - call.chargedCostMicrosCny,
  };
  if (!validUsage)
    error = problem('EXECUTION_USAGE_INVALID', '调用返回无效用量，保留预占额度并停止执行。');
  else if (tokens > call.reservedTokens || cost > call.reservedCostMicrosCny)
    error = problem(
      'EXECUTION_RESERVATION_EXCEEDED',
      '调用消耗超过适配器声明的上界，已记录消耗并停止执行。',
    );
  error = budgetFailure(updatedBudget, 0, 0, 0) ?? error;
  await tx
    .update(executionBudgets)
    .set({
      chargedTokens: updatedBudget.chargedTokens,
      chargedCostMicrosCny: updatedBudget.chargedCostMicrosCny,
    })
    .where(eq(executionBudgets.taskId, job.task.id));
  await tx
    .update(executionCalls)
    .set({
      status: error ? (timedOut ? 'timed_out' : 'failed') : 'succeeded',
      finishedAt: now,
      error,
      chargedTokens,
      chargedCostMicrosCny: chargedCost,
      tokensKnown: validUsage && tokensKnown,
      costKnown: validUsage && costKnown,
    })
    .where(eq(executionCalls.id, call.id));
  await tx.insert(auditEvents).values({
    teamId: job.task.teamId,
    taskId: job.task.id,
    actorType: 'worker',
    actorId: job.attempt.executorId,
    action: 'execution.call_finished',
    targetType: 'execution_call',
    targetId: call.id,
    outcome: error ? 'failed' : 'succeeded',
    reason: error?.message,
    requestId: `result:${call.id}`,
    createdAt: now,
  });
  if (!error) return 'advance';
  const limits = job.attempt.executionLimits!;
  const retryable =
    (timedOut && error.code === 'EXECUTION_CALL_TIMEOUT') ||
    (outcome.canRetry && transientCodes.some((code) => code === error!.code));
  const delay = limits.retryBaseMs * 2 ** step.retryCount;
  if (
    retryable &&
    step.retryCount < limits.maxRetries &&
    activeDuration(job.attempt, now) + delay < limits.attemptTimeoutMs &&
    now.getTime() + delay < step.startedAt!.getTime() + limits.stepTimeoutMs
  ) {
    await tx
      .update(executionSteps)
      .set({ retryCount: step.retryCount + 1, nextCallAt: new Date(now.getTime() + delay) })
      .where(eq(executionSteps.id, step.id));
    await tx
      .update(executionAttempts)
      .set({ nextRunAt: new Date(now.getTime() + delay) })
      .where(eq(executionAttempts.id, job.attempt.id));
    await tx
      .update(tasks)
      .set({ revision: job.task.revision + 1, updatedAt: now })
      .where(eq(tasks.id, job.task.id));
    await tx.insert(auditEvents).values({
      teamId: job.task.teamId,
      taskId: job.task.id,
      actorType: 'system',
      actorId: 'execution-control',
      action: 'execution.retry_scheduled',
      targetType: 'execution_step',
      targetId: step.id,
      outcome: 'succeeded',
      reason: error.message,
      requestId: `retry:${call.id}`,
      createdAt: now,
    });
    return 'retry';
  }
  if (retryable && limits.maxRetries > 0 && step.retryCount >= limits.maxRetries)
    error = problem(
      'EXECUTION_RETRIES_EXHAUSTED',
      `步骤技术重试次数已耗尽，最后原因：${error.code}。`,
    );
  await endControlledAttempt(tx, job, now, error);
  return 'failed';
}

/** Also runs with new task admission disabled; time limits cannot be evaded by slow adapters. */
export async function expireControlledAttempts(db: Database, clock?: () => Date) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
    const now = await executionNow(tx, clock);
    const jobs = await tx
      .select({ task: tasks, attempt: executionAttempts, step: executionSteps })
      .from(tasks)
      .innerJoin(
        executionAttempts,
        and(
          eq(executionAttempts.taskId, tasks.id),
          eq(executionAttempts.id, tasks.currentAttemptId),
          eq(executionAttempts.generation, tasks.workGeneration),
        ),
      )
      .innerJoin(
        executionSteps,
        and(
          eq(executionSteps.attemptId, executionAttempts.id),
          eq(executionSteps.status, 'running'),
        ),
      )
      .where(
        and(
          eq(executionAttempts.status, 'running'),
          isNotNull(executionAttempts.executionLimits),
          sql`(${executionAttempts.activeElapsedMs} + greatest(0, extract(epoch FROM (${now}::timestamptz - ${executionAttempts.activeSince})) * 1000) >= (${executionAttempts.executionLimits}->>'attemptTimeoutMs')::bigint OR ${executionSteps.startedAt} + (${executionAttempts.executionLimits}->>'stepTimeoutMs')::bigint * interval '1 millisecond' <= ${now})`,
        ),
      )
      .limit(20)
      .for('update', { of: [tasks, executionAttempts, executionSteps], skipLocked: true });
    let changed = 0;
    for (const job of jobs) {
      const error = timeFailure(job.attempt, job.step, now);
      if (error) {
        await endControlledAttempt(tx, job, now, error);
        changed++;
      }
    }
    return changed;
  });
}
