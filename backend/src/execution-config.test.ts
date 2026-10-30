import assert from 'node:assert/strict';
import test from 'node:test';
import { readExecutorMode } from './execution-config.js';

test('本地启用显式模拟执行，生产默认关闭且拒绝模拟模式', () => {
  assert.equal(readExecutorMode({}), 'mock');
  assert.equal(readExecutorMode({ TASK_EXECUTOR_MODE: 'disabled' }), 'disabled');
  assert.equal(readExecutorMode({ NODE_ENV: 'production' }), 'disabled');
  assert.throws(() => readExecutorMode({ NODE_ENV: 'production', TASK_EXECUTOR_MODE: 'mock' }));
  assert.throws(() => readExecutorMode({ TASK_EXECUTOR_MODE: 'agent' }));
});
