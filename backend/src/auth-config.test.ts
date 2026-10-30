import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readAuthConfig } from './auth-config.js';
import { cookieToken } from './auth.js';
import { createApp } from './app.js';

test('production requires explicit secret and HTTPS origins; local development has bounded defaults', () => {
  const secret = randomBytes(32).toString('hex');
  assert.equal(readAuthConfig({}), undefined);
  assert.throws(() => readAuthConfig({ NODE_ENV: 'production' }));
  assert.throws(() => readAuthConfig({ AUTH_SECRET: 'not-a-key' }));
  assert.throws(() => readAuthConfig({ AUTH_SECRET: secret, NODE_ENV: 'production' }));
  for (const origin of [
    '*',
    'https://example.com/path',
    'https://user:secret@example.com',
    'http://example.com',
  ])
    assert.throws(() => readAuthConfig({ AUTH_SECRET: secret, AUTH_TRUSTED_ORIGINS: origin }));
  assert.equal(readAuthConfig({ AUTH_SECRET: secret })!.secureCookie, false);
  const config = readAuthConfig({
    AUTH_SECRET: secret,
    NODE_ENV: 'production',
    AUTH_TRUSTED_ORIGINS: 'https://ops.example.com',
  })!;
  assert.equal(config.secureCookie, true);
  assert.deepEqual(config.trustedOrigins, ['https://ops.example.com']);
});

test('ambiguous or malformed session cookies are rejected', () => {
  const token = randomBytes(32).toString('base64url');
  assert.equal(cookieToken(`other=x; ops_session=${token}`), token);
  for (const cookie of [
    undefined,
    '',
    'ops_session=short',
    'ops_session=%INVALID',
    `ops_session=${token}; ops_session=${token}`,
    'x'.repeat(8193),
  ])
    assert.equal(cookieToken(cookie), undefined);
});

test('unconfigured authentication fails explicitly, without exposing credentials or fake sessions', async () => {
  const app = createApp({
    logging: false,
    checkDatabase: async () => ({ status: 'not_ready', database: 'unconfigured' }),
    checkAgent: async () => {
      throw new Error('not used');
    },
  });
  try {
    assert.equal((await app.inject('/api/v1/auth/me')).statusCode, 401);
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:5173', 'idempotency-key': 'synthetic-key-0001' },
      payload: { login: 'synthetic-admin', password: 'synthetic-password' },
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(!result.body.includes('synthetic-password'));
  } finally {
    await app.close();
  }
});
