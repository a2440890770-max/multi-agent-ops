import assert from 'node:assert/strict';
import test from 'node:test';
import { readExecutorMode, readExecutorPolicy } from './execution-config.js';

test('本地启用显式模拟执行，生产默认关闭且拒绝模拟模式', () => {
  assert.equal(readExecutorMode({}), 'mock');
  assert.equal(readExecutorMode({ TASK_EXECUTOR_MODE: 'disabled' }), 'disabled');
  assert.equal(readExecutorMode({ NODE_ENV: 'production' }), 'disabled');
  assert.throws(() => readExecutorMode({ NODE_ENV: 'production', TASK_EXECUTOR_MODE: 'mock' }));
  assert.throws(() => readExecutorMode({ TASK_EXECUTOR_MODE: 'agent' }));
});

test('执行器默认单并发，配置拒绝无法安全续租或无界并发的参数', () => {
  assert.deepEqual(readExecutorPolicy({}), {
    pollMs: 500,
    heartbeatMs: 5000,
    leaseMs: 30000,
    concurrency: 1,
  });
  assert.equal(readExecutorPolicy({ TASK_EXECUTOR_CONCURRENCY: '3' }).concurrency, 3);
  for (const env of [
    { TASK_EXECUTOR_CONCURRENCY: '0' },
    { TASK_EXECUTOR_CONCURRENCY: '33' },
    { TASK_EXECUTOR_CONCURRENCY: '1.5' },
    { TASK_EXECUTOR_CONCURRENCY: 'Infinity' },
    { TASK_EXECUTOR_LEASE_MS: '14000' },
    { TASK_EXECUTOR_HEARTBEAT_MS: '15000' },
    { TASK_EXECUTOR_POLL_MS: '15000' },
    { TASK_EXECUTOR_LEASE_MS: '-1' },
  ])
    assert.throws(() => readExecutorPolicy(env));
});

test('第二批默认120秒调用及跨尝试预算，拒绝无界或矛盾的超时和重试配置', async () => {
  const { readExecutionLimits } = await import('./execution-config.js');
  assert.deepEqual(readExecutionLimits({}), {
    callTimeoutMs: 120000,
    stepTimeoutMs: 300000,
    attemptTimeoutMs: 1200000,
    maxRetries: 2,
    retryBaseMs: 2000,
    maxCalls: 50,
    maxTokens: 100000,
    maxCostMicrosCny: 10000000,
  });
  for (const env of [
    { TASK_CALL_TIMEOUT_MS: '0' },
    { TASK_CALL_TIMEOUT_MS: '300001' },
    { TASK_STEP_TIMEOUT_MS: '1200001' },
    { TASK_TECHNICAL_MAX_RETRIES: '11' },
    { TASK_TECHNICAL_MAX_RETRIES: '-1' },
    { TASK_BUDGET_MAX_CALLS: '0' },
    { TASK_BUDGET_MAX_TOKENS: '1.2' },
    { TASK_BUDGET_MAX_COST_MICROS_CNY: 'Infinity' },
  ])
    assert.throws(() => readExecutionLimits(env));
});
