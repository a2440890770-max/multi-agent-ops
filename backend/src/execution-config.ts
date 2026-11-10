export function readExecutorMode(env: {
  NODE_ENV?: string;
  TASK_EXECUTOR_MODE?: string;
}): 'mock' | 'agent' | 'disabled' {
  const value =
    env.TASK_EXECUTOR_MODE?.trim() || (env.NODE_ENV === 'production' ? 'disabled' : 'mock');
  if (value !== 'mock' && value !== 'agent' && value !== 'disabled')
    throw new Error('TASK_EXECUTOR_MODE 仅支持 mock、agent 或 disabled。');
  if (value === 'mock' && env.NODE_ENV === 'production')
    throw new Error('生产环境禁止模拟执行，请设置 TASK_EXECUTOR_MODE=disabled。');
  return value;
}

export interface ExecutorPolicy {
  pollMs: number;
  heartbeatMs: number;
  leaseMs: number;
  concurrency: number;
}

export function readExecutorPolicy(env: Record<string, string | undefined>): ExecutorPolicy {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : fallback;
    if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} 必须为 ${min}—${max} 的整数。`);
    return value;
  };
  const policy = {
    pollMs: integer('TASK_EXECUTOR_POLL_MS', 500, 10, 60_000),
    heartbeatMs: integer('TASK_EXECUTOR_HEARTBEAT_MS', 5_000, 10, 60_000),
    leaseMs: integer('TASK_EXECUTOR_LEASE_MS', 30_000, 100, 600_000),
    concurrency: integer('TASK_EXECUTOR_CONCURRENCY', 1, 1, 32),
  };
  if (policy.leaseMs < 3 * Math.max(policy.heartbeatMs, policy.pollMs))
    throw new Error('TASK_EXECUTOR_LEASE_MS 必须至少为心跳和轮询间隔的三倍。');
  return policy;
}

export type ExecutionLimits = import('@multi-agent-ops/shared').ExecutionLimits;

/** Time and budget policies are snapshotted; edits affect new attempts/tasks only. */
export function readExecutionLimits(env: Record<string, string | undefined>): ExecutionLimits {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : fallback;
    if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} 必须为 ${min}—${max} 的整数。`);
    return value;
  };
  const limits = {
    callTimeoutMs: integer('TASK_CALL_TIMEOUT_MS', 120_000, 10, 3_600_000),
    stepTimeoutMs: integer('TASK_STEP_TIMEOUT_MS', 300_000, 10, 86_400_000),
    attemptTimeoutMs: integer('TASK_ATTEMPT_TIMEOUT_MS', 1_200_000, 10, 86_400_000),
    maxRetries: integer('TASK_TECHNICAL_MAX_RETRIES', 2, 0, 10),
    retryBaseMs: integer('TASK_TECHNICAL_RETRY_BASE_MS', 2_000, 10, 60_000),
    maxCalls: integer('TASK_BUDGET_MAX_CALLS', 50, 1, 10_000),
    maxTokens: integer('TASK_BUDGET_MAX_TOKENS', 100_000, 1, 1_000_000_000),
    maxCostMicrosCny: integer('TASK_BUDGET_MAX_COST_MICROS_CNY', 1_000_000, 1, 1_000_000_000_000),
  };
  if (limits.callTimeoutMs > limits.stepTimeoutMs || limits.stepTimeoutMs > limits.attemptTimeoutMs)
    throw new Error('调用超时不得大于步骤超时，步骤超时不得大于执行总超时。');
  if (limits.retryBaseMs * 2 ** Math.max(0, limits.maxRetries - 1) > 3_600_000)
    throw new Error('最大技术重试等待不得超过一小时。');
  return limits;
}
