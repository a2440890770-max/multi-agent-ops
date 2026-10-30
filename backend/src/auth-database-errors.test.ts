import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import type { AuthService } from './auth.js';
import { createApp } from './app.js';
import { databaseErrorCode } from './database-errors.js';

test('缺少认证审计字段时返回可操作的升级提示，日志仅包含安全错误码', async () => {
  let logs = '';
  const app = createApp({
    auth: {
      assertOrigin() {},
      async login() {
        throw new Error('private SQL parameters', {
          cause: Object.assign(new Error('private driver details'), { code: '42703' }),
        });
      },
    } as unknown as AuthService,
    logStream: new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    }),
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('must not call');
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:5173', 'idempotency-key': 'auth-schema-regression-001' },
      payload: { login: 'synthetic-admin', password: 'synthetic-password' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.match(response.json().error.message, /数据库结构尚未升级/);
    assert.match(logs, /42703/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.doesNotMatch(response.body + logs, /synthetic-password|private SQL|private driver/);
  } finally {
    await app.close();
  }
});
test('数据库错误分类支持包装错误并限制读取深度', () => {
  assert.equal(databaseErrorCode({ cause: { code: '42P01' } }), '42P01');
  assert.equal(databaseErrorCode(new Error('no code')), undefined);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(databaseErrorCode(cycle), undefined);
});
