import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import pg from 'pg';
import Fastify from 'fastify';
import { endpoints } from '../shared/src/index.ts';
import { runMigrations } from './migrations.mjs';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { hashPassword } from '../backend/src/password.ts';
import { AuthService, SESSION_MILLISECONDS } from '../backend/src/auth.ts';
import { createApp } from '../backend/src/app.ts';
import { registerBusinessAuthorization } from '../backend/src/authorization.ts';

const rawUrl = process.env.AUTH_TEST_DATABASE_URL;
if (!rawUrl || !/^auth_test_[a-f0-9]{12}$/.test(new URL(rawUrl).pathname.slice(1)))
  throw new Error(
    '认证集成测试只接受显式 AUTH_TEST_DATABASE_URL，库名必须为 auth_test_<12位随机十六进制>。',
  );
const client = new pg.Client({ connectionString: rawUrl, connectionTimeoutMillis: 5000 });
const config = {
  secret: randomBytes(32),
  trustedOrigins: ['http://127.0.0.1:5173'],
  secureCookie: false,
};
const password = 'synthetic-auth-password';
const origin = config.trustedOrigins[0];
let database, app, memberId, teamId, now, storedHash;

function application(options = {}, logging = {}) {
  return createApp({
    auth: new AuthService(database.db, config, {
      now: () => new Date(now),
      accountAttempts: 100,
      ipAttempts: 100,
      ...options,
    }),
    logging: false,
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('not used');
    },
    ...logging,
  });
}
function login(options = {}) {
  const headers = Object.fromEntries(
    Object.entries({
      origin,
      'idempotency-key': options.key ?? randomUUID(),
      ...options.headers,
    }).filter(([, value]) => value !== undefined),
  );
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers,
    payload: options.payload ?? { login: 'admin.synthetic', password },
    ...(options.ip ? { remoteAddress: options.ip } : {}),
  });
}
const cookie = (response) => response.headers['set-cookie'].split(';')[0];
const token = (response) => cookie(response).slice('ops_session='.length);
const me = (value) => app.inject({ url: '/api/v1/auth/me', headers: { cookie: value } });
const count = async (table) =>
  (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
async function stateCounts() {
  const counts = [];
  for (const table of ['sessions', 'audit_events', 'idempotency_records', 'tasks'])
    counts.push(await count(table));
  return counts;
}

const businessEndpoints = endpoints.filter(
  (endpoint) => !['login', 'getMe', 'logout'].includes(endpoint.operationId),
);
function validInput(schema) {
  if (schema.enum) return schema.enum[0];
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  if (schema.type === 'object')
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [name, validInput(schema.properties[name])]),
    );
  if (schema.type === 'array')
    return Array.from({ length: schema.minItems ?? 0 }, () => validInput(schema.items));
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  if (schema.format === 'uri') return 'https://example.com/evidence';
  if (schema.pattern === '^[a-f0-9]{64}$') return 'a'.repeat(64);
  return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
}
function businessRequest(operationId, identity, overrides = {}) {
  const endpoint = businessEndpoints.find((entry) => entry.operationId === operationId);
  assert.ok(endpoint, operationId);
  const query = endpoint.query ? new URLSearchParams(validInput(endpoint.query)).toString() : '';
  return app.inject({
    method: endpoint.method,
    url: `/api/v1${endpoint.path.replace(/:[A-Za-z]+/g, 'id')}${query ? `?${query}` : ''}`,
    ...(endpoint.body ? { payload: validInput(endpoint.body) } : {}),
    ...overrides,
    headers: Object.fromEntries(
      Object.entries({
        origin,
        'idempotency-key': randomUUID(),
        ...(identity
          ? { cookie: cookie(identity), 'x-csrf-token': identity.json().data.csrfToken }
          : {}),
        ...overrides.headers,
      }).filter(([, value]) => value !== undefined),
    ),
  });
}
async function operatorLogin() {
  await client.query(
    `INSERT INTO members(team_id,login,password_hash,display_name,role,password_changed_at)
     VALUES ($1,'operator.synthetic',$2,'Synthetic Operator','operator',$3)`,
    [teamId, storedHash, new Date(now.getTime() - 1000)],
  );
  const result = await login({ payload: { login: 'operator.synthetic', password } });
  assert.equal(result.statusCode, 200, result.body);
  return result;
}

before(async () => {
  await client.connect();
  await runMigrations(client, 'migrate');
  storedHash = await hashPassword(password);
  const appPassword = randomBytes(24).toString('hex');
  await client.query(
    `CREATE ROLE auth_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}'`,
  );
  await client.query('GRANT USAGE ON SCHEMA public TO auth_test_app');
  await client.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO auth_test_app',
  );
  const appUrl = new URL(rawUrl);
  appUrl.username = 'auth_test_app';
  appUrl.password = appPassword;
  database = createBusinessDatabase(appUrl.href);
});
beforeEach(async () => {
  if (app) await app.close();
  await client.query('TRUNCATE teams,idempotency_records,tasks CASCADE');
  now = new Date();
  teamId = (await client.query("INSERT INTO teams(name) VALUES ('synthetic team') RETURNING id"))
    .rows[0].id;
  memberId = (
    await client.query(
      `INSERT INTO members(team_id,login,password_hash,display_name,role,password_changed_at)
    VALUES ($1,'admin.synthetic',$2,'Synthetic Admin','admin',$3) RETURNING id`,
      [teamId, storedHash, new Date(now.getTime() - 1000)],
    )
  ).rows[0].id;
  app = application();
});
after(async () => {
  if (app) await app.close();
  if (database) await database.close();
  await client.end();
});

test('登录契约、Origin 和未知字段校验不产生会话', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }])
    assert.equal((await login({ headers })).statusCode, 403);
  assert.equal((await login({ headers: { 'idempotency-key': undefined } })).statusCode, 400);
  assert.equal(
    (await login({ payload: { login: 'admin.synthetic', password, role: 'admin' } })).statusCode,
    400,
  );
  assert.equal(await count('sessions'), 0);
  assert.equal(await count('audit_events'), 0);
});

test('登录创建 8 小时持久会话，JSON 无凭据，数据库仅存摘要及加密重放', async () => {
  const result = await login();
  assert.equal(result.statusCode, 200, result.body);
  const body = result.json();
  assert.equal(body.data.member.role, 'admin');
  assert.equal(body.data.member.id, memberId);
  assert.equal(body.data.member.teamId, teamId);
  assert.ok(body.data.permissions.includes('settings:write'));
  assert.equal(new Date(body.data.expiresAt).getTime() - now.getTime(), SESSION_MILLISECONDS);
  assert.match(result.headers['set-cookie'], /HttpOnly/);
  assert.match(result.headers['set-cookie'], /SameSite=Lax/);
  assert.match(result.headers['set-cookie'], /Path=\//);
  assert.doesNotMatch(result.headers['set-cookie'], /Secure/);
  assert.equal(result.headers['cache-control'], 'no-store');
  for (const secret of [password, storedHash, token(result)])
    assert.ok(!result.body.includes(secret));
  assert.ok(!('passwordHash' in body.data.member));
  const session = (await client.query('SELECT * FROM sessions')).rows[0];
  assert.equal(session.token_hash, createHash('sha256').update(token(result)).digest('hex'));
  assert.equal(session.issued_auth_version, 1);
  assert.equal(session.csrf_secret.length, 32);
  const replay = (await client.query('SELECT * FROM idempotency_records')).rows[0];
  assert.ok(replay.encrypted_replay instanceof Buffer);
  assert.equal(replay.response_body, null);
  const records = JSON.stringify(
    (await client.query('SELECT row_to_json(t) FROM idempotency_records t')).rows,
  );
  assert.ok(!records.includes(password));
  assert.ok(!replay.encrypted_replay.toString('utf8').includes(token(result)));
});

test('me 返回稳定 CSRF、当前权限；刷新不续期或写入业务记录', async () => {
  const first = await login();
  const before = await count('audit_events');
  now = new Date(now.getTime() + 60_000);
  const current = await me(cookie(first));
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().data.csrfToken, first.json().data.csrfToken);
  assert.equal(current.json().data.expiresAt, first.json().data.expiresAt);
  assert.equal(await count('audit_events'), before);
  assert.equal((await app.inject('/api/v1/auth/me')).statusCode, 401);
  assert.equal((await me('ops_session=invalid')).statusCode, 401);
  assert.equal((await me(cookie(first) + '; ' + cookie(first))).statusCode, 401);
});

test('错误密码、不存在和禁用账号使用统一凭据错误', async () => {
  const wrong = await login({
    payload: { login: 'admin.synthetic', password: 'incorrect-synthetic-password' },
  });
  const missing = await login({ payload: { login: 'missing.synthetic', password } });
  await client.query("UPDATE members SET status='disabled' WHERE id=$1", [memberId]);
  const disabled = await login();
  for (const response of [wrong, missing, disabled]) {
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.message, '账号或密码错误。');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(await count('sessions'), 0);
  assert.equal(await count('idempotency_records'), 0);
});

test('会话绝对过期；过期退出无需 CSRF，且旧请求不能复活会话', async () => {
  const key = randomUUID();
  const first = await login({ key });
  now = new Date(now.getTime() + SESSION_MILLISECONDS - 1);
  assert.equal((await me(cookie(first))).statusCode, 200);
  now = new Date(now.getTime() + 1);
  assert.equal((await me(cookie(first))).statusCode, 401);
  const exit = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { origin, cookie: cookie(first) },
  });
  assert.equal(exit.statusCode, 200);
  assert.equal((await login({ key })).statusCode, 401);
  assert.equal(await count('sessions'), 1);
});

test('退出要求可信来源和 CSRF，正确退出立即撤销且可重复', async () => {
  const key = randomUUID();
  const first = await login({ key });
  const headers = { origin, cookie: cookie(first) };
  for (const extra of [
    {},
    { 'x-csrf-token': 'forged' },
    { 'x-csrf-token': first.json().data.csrfToken, origin: 'https://evil.example' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...headers, ...extra },
    });
    assert.equal(response.statusCode, 403);
  }
  const exit = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { ...headers, 'x-csrf-token': first.json().data.csrfToken },
  });
  assert.equal(exit.statusCode, 200);
  assert.equal(exit.json().data.signedOut, true);
  assert.match(exit.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await me(cookie(first))).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode,
    200,
  );
  assert.equal((await login({ key })).statusCode, 401);
  assert.equal((await login()).statusCode, 200);
});

test('角色变更即时反映；禁用和认证版本变更使旧会话失效', async () => {
  const first = await login();
  await client.query("UPDATE members SET role='operator',version=version+1 WHERE id=$1", [
    memberId,
  ]);
  const current = await me(cookie(first));
  assert.equal(current.json().data.member.role, 'operator');
  assert.ok(!current.json().data.permissions.includes('settings:write'));
  await client.query(
    "UPDATE members SET status='disabled',auth_version=auth_version+1 WHERE id=$1",
    [memberId],
  );
  assert.equal((await me(cookie(first))).statusCode, 401);
  await client.query("UPDATE members SET status='active' WHERE id=$1", [memberId]);
  assert.equal((await me(cookie(first))).statusCode, 401);
  const second = await login();
  assert.equal(second.statusCode, 200);
  await client.query('UPDATE members SET password_changed_at=$1 WHERE id=$2', [
    new Date(now.getTime() + 1000),
    memberId,
  ]);
  assert.equal((await me(cookie(second))).statusCode, 401);
});

test('并发重传和服务重启复用同一持久会话，不重复成功审计', async () => {
  const key = randomUUID();
  const responses = await Promise.all([login({ key }), login({ key })]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  assert.equal(cookie(responses[0]), cookie(responses[1]));
  assert.deepEqual(responses.map((r) => r.json().meta.replayed).sort(), [false, true]);
  assert.equal(await count('sessions'), 1);
  assert.equal(await count('idempotency_records'), 1);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='auth.login' AND outcome='succeeded'",
      )
    ).rows[0].n,
    1,
  );
  await app.close();
  app = application();
  const replay = await login({ key });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().meta.replayed, true);
  assert.equal(cookie(replay), cookie(responses[0]));
  assert.equal((await me(cookie(replay))).statusCode, 200);
});

test('相同动作键不同规范化前请求返回冲突；加密重放被篡改时不发放会话', async () => {
  const key = randomUUID();
  assert.equal((await login({ key })).statusCode, 200);
  const conflict = await login({ key, payload: { login: 'ADMIN.SYNTHETIC', password } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  await client.query('UPDATE idempotency_records SET encrypted_replay=$1', [Buffer.alloc(72)]);
  assert.equal((await login({ key })).statusCode, 500);
  assert.equal(await count('sessions'), 1);
});

test('账号和 IP 限流跨服务实例生效；窗口结束后恢复', async () => {
  await app.close();
  app = application({ accountAttempts: 2, ipAttempts: 3 });
  const wrong = { login: 'admin.synthetic', password: 'incorrect-synthetic-password' };
  assert.equal((await login({ payload: wrong })).statusCode, 401);
  assert.equal((await login({ payload: wrong })).statusCode, 401);
  await app.close();
  app = application({ accountAttempts: 2, ipAttempts: 3 });
  const blocked = await login();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '900');
  assert.equal((await login({ payload: { login: 'other.synthetic', password } })).statusCode, 401);
  assert.equal((await login({ payload: { login: 'third.synthetic', password } })).statusCode, 429);
  now = new Date(now.getTime() + 15 * 60 * 1000);
  assert.equal((await login()).statusCode, 200);
});

test('成功审计失败时会话和重放记录一起回滚', async () => {
  await client.query(`CREATE FUNCTION auth_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='auth.login' AND NEW.outcome='succeeded' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
  await client.query(
    'CREATE TRIGGER auth_test_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION auth_test_audit_failure()',
  );
  try {
    const result = await login();
    assert.equal(result.statusCode, 503);
    assert.equal(await count('sessions'), 0);
    assert.equal(await count('idempotency_records'), 0);
    assert.ok(!result.body.includes(password));
    assert.ok(!result.body.includes('INSERT'));
  } finally {
    await client.query('DROP TRIGGER auth_test_audit_failure ON audit_events');
    await client.query('DROP FUNCTION auth_test_audit_failure()');
  }
});

test('生产 Cookie 包含 Secure；请求及错误日志不泄露密码、Cookie 或 CSRF', async () => {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  await app.close();
  const auth = new AuthService(
    database.db,
    { ...config, secureCookie: true },
    { now: () => new Date(now) },
  );
  app = application({}, { auth, logging: true, logStream: stream });
  const first = await login();
  assert.equal(first.statusCode, 200);
  assert.match(first.headers['set-cookie'], /; Secure/);
  await me(cookie(first));
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { origin, cookie: cookie(first), 'x-csrf-token': first.json().data.csrfToken },
  });
  for (const secret of [password, storedHash, token(first), first.json().data.csrfToken])
    assert.ok(!logs.includes(secret));
  assert.ok(logs.includes('request completed'));
  stream.end();
});

test('数据库不可用时返回 503，不伪装登录成功或泄露连接信息', async () => {
  const unavailable = new URL(rawUrl);
  unavailable.port = '1';
  const broken = createBusinessDatabase(unavailable.href);
  await app.close();
  app = application({}, { auth: new AuthService(broken.db, config) });
  try {
    const result = await login();
    assert.equal(result.statusCode, 503);
    assert.equal(result.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.ok(!result.body.includes(unavailable.href));
    assert.ok(!result.body.includes(password));
  } finally {
    await broken.close();
  }
});

test('全部业务契约覆盖未登录 401、运营管理操作 403、允许身份通过权限校验', async () => {
  const admin = await login();
  assert.equal(admin.statusCode, 200, admin.body);
  const operator = await operatorLogin();
  const beforeCounts = await stateCounts();
  for (const endpoint of businessEndpoints) {
    for (const [identity, role] of [
      [null, null],
      [operator, 'operator'],
      [admin, 'admin'],
    ]) {
      const result = await businessRequest(endpoint.operationId, identity);
      const status = !identity ? 401 : endpoint.roles.includes(role) ? 501 : 403;
      assert.equal(result.statusCode, status, `${endpoint.operationId}/${role}: ${result.body}`);
      assert.equal(
        result.json().error.code,
        status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'NOT_IMPLEMENTED',
      );
      assert.ok(result.json().meta.requestId);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['set-cookie'], undefined);
      for (const secret of [password, storedHash, token(admin), token(operator)])
        assert.ok(!result.body.includes(secret));
    }
  }
  assert.deepEqual(
    await stateCounts(),
    beforeCounts,
    'permission checks and contract stubs must not change business state',
  );
});

test('业务写入验证可信 Origin 和会话绑定 CSRF，读取不要求写入头', async () => {
  const admin = await login();
  const operator = await operatorLogin();
  for (const identity of [admin, operator]) {
    for (const headers of [
      { origin: undefined },
      { origin: 'https://evil.example' },
      { 'x-csrf-token': undefined },
      { 'x-csrf-token': 'forged' },
      { 'x-csrf-token': (identity === admin ? operator : admin).json().data.csrfToken },
    ]) {
      const result = await businessRequest('createTask', identity, { headers });
      assert.equal(result.statusCode, 403, result.body);
      assert.equal(result.json().error.code, 'FORBIDDEN');
    }
    assert.equal((await businessRequest('createTask', identity)).statusCode, 501);
    assert.equal(
      (
        await businessRequest('listTasks', identity, {
          headers: { origin: undefined, 'x-csrf-token': undefined, 'idempotency-key': undefined },
        })
      ).statusCode,
      501,
    );
  }
});

test('权限先于参数和 JSON 校验，伪造身份头及请求体不能提升运营权限', async () => {
  const operator = await operatorLogin();
  for (const operationId of ['updateMember', 'updateConfig', 'authorizeAccount']) {
    for (const identity of [null, operator]) {
      const result = await businessRequest(operationId, identity, {
        payload: '{broken-json',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': undefined,
          'x-csrf-token': undefined,
          'x-role': 'admin',
          'x-member-id': memberId,
          authorization: 'Bearer forged-admin',
        },
      });
      assert.equal(result.statusCode, identity ? 403 : 401, result.body);
    }
    const spoof = await businessRequest(operationId, operator, {
      payload: { role: 'admin', memberId, teamId },
    });
    assert.equal(spoof.statusCode, 403, spoof.body);
  }
  const headers = { 'content-type': 'application/json' };
  for (const payload of [
    { body: '新文案' },
    { expectedRevision: 12, body: '新文案' },
    { expectedRevision: 12, baseContentVersionId: 'v3', body: '新文案', status: 'published' },
    { expectedRevision: -1, baseContentVersionId: 'v3', body: '新文案' },
    '{broken-json',
  ]) {
    const result = await businessRequest('saveContent', operator, { payload, headers });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().error.code, 'VALIDATION_ERROR');
  }
  const missingKey = await businessRequest('createTask', operator, {
    headers: { 'idempotency-key': undefined },
  });
  assert.equal(missingKey.statusCode, 400);
});

test('业务请求逐次复核角色；降级、升级、禁用、撤销、改密和绝对过期立即生效', async () => {
  const identity = await login();
  assert.equal((await businessRequest('listMembers', identity)).statusCode, 501);
  await client.query("UPDATE members SET role='operator',version=version+1 WHERE id=$1", [
    memberId,
  ]);
  assert.equal((await businessRequest('listMembers', identity)).statusCode, 403);
  assert.equal((await businessRequest('getConfig', identity)).statusCode, 403);
  assert.equal((await businessRequest('updateConfig', identity)).statusCode, 403);
  assert.equal((await businessRequest('listTasks', identity)).statusCode, 501);
  await client.query("UPDATE members SET role='admin',version=version+1 WHERE id=$1", [memberId]);
  assert.equal((await businessRequest('listMembers', identity)).statusCode, 501);
  assert.equal((await businessRequest('updateConfig', identity)).statusCode, 501);

  for (const update of [
    "UPDATE members SET status='disabled' WHERE id=$1",
    'UPDATE members SET auth_version=auth_version+1 WHERE id=$1',
    "UPDATE members SET password_changed_at=now()+interval '1 day' WHERE id=$1",
  ]) {
    await client.query(update, [memberId]);
    for (const operationId of ['listTasks', 'listMembers', 'createTask'])
      assert.equal((await businessRequest(operationId, identity)).statusCode, 401, update);
    await client.query(
      "UPDATE members SET status='active',auth_version=1,password_changed_at=$1 WHERE id=$2",
      [new Date(now.getTime() - 1000), memberId],
    );
  }
  now = new Date(now.getTime() + SESSION_MILLISECONDS);
  assert.equal((await businessRequest('listTasks', identity)).statusCode, 401);
  now = new Date(now.getTime() - SESSION_MILLISECONDS);
  const signedOut = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { origin, cookie: cookie(identity), 'x-csrf-token': identity.json().data.csrfToken },
  });
  assert.equal(signedOut.statusCode, 200);
  assert.equal((await businessRequest('listTasks', identity)).statusCode, 401);
  assert.equal((await businessRequest('createTask', identity)).statusCode, 401);
});

test('伪造、重复或损坏的业务会话 Cookie 返回 401', async () => {
  const identity = await login();
  for (const value of [
    `ops_session=${randomBytes(32).toString('base64url')}`,
    `${cookie(identity)}; ${cookie(identity)}`,
    'ops_session=short',
    'ops_session=%INVALID',
  ]) {
    const result = await businessRequest('listTasks', null, { headers: { cookie: value } });
    assert.equal(result.statusCode, 401, result.body);
    assert.equal(result.json().error.code, 'UNAUTHENTICATED');
  }
});

test('业务权限校验依赖失败返回安全的 503，响应和日志不泄露凭据', async () => {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const identity = await login();
  await app.close();
  app = application({}, { logging: true, logStream: stream });
  const operator = await operatorLogin();
  await businessRequest('updateConfig', operator);
  await businessRequest('createTask', identity, { headers: { 'x-csrf-token': 'forged' } });
  await businessRequest('listTasks', identity);
  await app.close();
  const unavailable = new URL(rawUrl);
  unavailable.port = '1';
  const broken = createBusinessDatabase(unavailable.href);
  app = application(
    {},
    {
      auth: new AuthService(broken.db, config),
      logging: true,
      logStream: stream,
    },
  );
  try {
    const result = await businessRequest('listTasks', identity);
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(result.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.json().error.retryable, true);
    assert.equal((await businessRequest('listTasks', null)).statusCode, 401);
    for (const secret of [
      password,
      storedHash,
      token(identity),
      identity.json().data.csrfToken,
      unavailable.href,
    ]) {
      assert.ok(!result.body.includes(secret));
      assert.ok(!logs.includes(secret));
    }
    assert.ok(logs.includes('DEPENDENCY_UNAVAILABLE'));
  } finally {
    await app.close();
    await broken.close();
    stream.end();
  }
});

test('业务作用域默认拒绝未声明角色的新路由，并为允许的处理器提供可信成员上下文', async () => {
  const identity = await login();
  const scoped = Fastify({ logger: false });
  scoped.register(async (business) => {
    registerBusinessAuthorization(business, new AuthService(database.db, config));
    business.get('/undeclared', async () => {
      throw new Error('must never run');
    });
    business.get('/allowed', { config: { requiredRoles: ['admin'] } }, async (request) => ({
      memberId: request.authSession.member.id,
      teamId: request.authSession.member.teamId,
      role: request.authSession.member.role,
    }));
  });
  try {
    const headers = { cookie: cookie(identity), 'x-member-id': 'forged', 'x-role': 'operator' };
    assert.equal((await scoped.inject('/undeclared')).statusCode, 401);
    assert.equal((await scoped.inject({ url: '/undeclared', headers })).statusCode, 403);
    const result = await scoped.inject({ url: '/allowed', headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { memberId, teamId, role: 'admin' });
  } finally {
    await scoped.close();
  }
});
