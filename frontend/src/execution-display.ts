import type { ExecutionAttempt, Failure } from '@multi-agent-ops/shared';

export function elapsed(start: string, end: string | number) {
  return Math.max(0, (typeof end === 'number' ? end : Date.parse(end)) - Date.parse(start));
}

export function durationLabel(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '未记录';
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600
    ? `${minutes} 分 ${seconds % 60} 秒`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`;
}

export function executionDuration(attempt: ExecutionAttempt, now: number) {
  const control = attempt.control;
  // Legacy attempts have a default zero counter but no control policy. Do not
  // present that zero as a measurement of their historical execution time.
  if (!control?.limits) return null;
  return (
    control.activeElapsedMs +
    (attempt.status === 'running' && control.activeSince ? elapsed(control.activeSince, now) : 0)
  );
}

export function initialQueueDuration(attempt: ExecutionAttempt, now: number) {
  if (attempt.startedAt) return elapsed(attempt.createdAt, attempt.startedAt);
  if (!attempt.control?.limits) return null;
  if (attempt.status === 'queued') return elapsed(attempt.createdAt, now);
  if (attempt.status === 'cancelled' && attempt.finishedAt)
    return elapsed(attempt.createdAt, attempt.finishedAt);
  return null;
}

export function failureGuidance(failure: Failure) {
  if (failure.code.startsWith('EXECUTION_BUDGET_'))
    return {
      title: '预算超限',
      next: '任务累计预算不足，已停止后续调用。预算跨所有尝试累计，重新执行不会清零；请人工评估后决定是否另建任务。',
    };
  if (failure.code === 'EXECUTION_INTERRUPTED')
    return {
      title: '需人工处理',
      next: '执行进程中断，本次尝试已结束。确认情况后可使用“重新执行”创建新尝试，旧记录会保留。',
    };
  if (failure.code === 'EXECUTION_RETRIES_EXHAUSTED')
    return {
      title: '需人工处理',
      next: '技术重试次数已用尽。请检查失败记录和上游服务，确认恢复后再人工重新执行。',
    };
  if (failure.code === 'EXECUTION_PRICING_UNCONFIGURED')
    return {
      title: '需人工处理',
      next: '请联系管理员检查调用计价和用量上界配置，修复后再人工重新执行。',
    };
  if (['EXECUTION_USAGE_INVALID', 'EXECUTION_RESERVATION_EXCEEDED'].includes(failure.code))
    return {
      title: '需人工处理',
      next: '调用用量异常，已停止执行。请联系管理员核查适配器与用量记录，未知用量保留预占。',
    };
  return {
    title: '失败原因',
    next: '本次尝试已结束，不会自动继续。请检查失败原因，确认可继续后再人工重新执行。',
  };
}
