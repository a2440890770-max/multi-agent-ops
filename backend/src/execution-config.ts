export function readExecutorMode(env: {
  NODE_ENV?: string;
  TASK_EXECUTOR_MODE?: string;
}): 'mock' | 'disabled' {
  const value =
    env.TASK_EXECUTOR_MODE?.trim() || (env.NODE_ENV === 'production' ? 'disabled' : 'mock');
  if (value !== 'mock' && value !== 'disabled')
    throw new Error('TASK_EXECUTOR_MODE 仅支持 mock 或 disabled。');
  if (value === 'mock' && env.NODE_ENV === 'production')
    throw new Error('生产环境禁止模拟执行，请设置 TASK_EXECUTOR_MODE=disabled。');
  return value;
}
