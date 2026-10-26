import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';

const agent = {
  service: 'agent',
  status: 'ok',
  stage: 'D1',
  mode: 'shell',
  canExecuteTasks: false,
} as const;
test('数据库未配置时保留存活检查，但就绪检查必须返回 503', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'not_ready', database: 'unconfigured' }),
    checkAgent: async () => agent,
  });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    const response = await app.inject('/api/ready');
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().database, 'unconfigured');
  } finally {
    await app.close();
  }
});
test('数据库已连接时就绪；Agent 探测失败不会伪报健康', async () => {
  const app = createApp({
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('offline');
    },
  });
  try {
    assert.equal((await app.inject('/api/ready')).statusCode, 200);
    assert.equal((await app.inject('/api/agent-health')).statusCode, 503);
  } finally {
    await app.close();
  }
});
