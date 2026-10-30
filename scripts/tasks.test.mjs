import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import pg from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createApp } from '../backend/src/app.ts';
import { AuthService } from '../backend/src/auth.ts';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { hashPassword } from '../backend/src/password.ts';
import { TaskService } from '../backend/src/task-service.ts';
import { MockTaskExecutor } from '../backend/src/mock-task-executor.ts';
import { runMigrations } from './migrations.mjs';

// Explicit disposable target only: never load the project's environment or seed its business DB.
const rawUrl = process.env.TASK_TEST_DATABASE_URL;
if (!rawUrl || !/^tasks_test_[a-f0-9]{12}$/.test(new URL(rawUrl).pathname.slice(1)))
  throw new Error(
    '任务集成测试需要独立 TASK_TEST_DATABASE_URL，库名为 tasks_test_<12位随机十六进制>。',
  );
const client = new pg.Client({ connectionString: rawUrl, connectionTimeoutMillis: 5000 });
const config = {
  secret: randomBytes(32),
  trustedOrigins: ['http://127.0.0.1:5173'],
  secureCookie: false,
};
const origin = config.trustedOrigins[0];
const password = 'synthetic-tasks-password';
const appRole = 'tasks_test_app_' + randomBytes(6).toString('hex');
let database, app, memberId, teamId, accountId, now, storedHash, appUrl;
const body = {
  title: '新品介绍',
  originalRequest: '  保留原始要求：\r\n介绍三个功能；不要自动发布。\n',
  referenceInputs: [{ label: '产品说明', url: 'https://example.com/product' }],
};
function application(overrides = {}) {
  return createApp({
    auth: new AuthService(database.db, config, {
      now: () => new Date(now),
      accountAttempts: 100,
      ipAttempts: 100,
    }),
    tasks: new TaskService(database.db, () => new Date(now)),
    logging: false,
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('Creating a task must never call an Agent');
    },
    ...overrides,
  });
}
async function login(login = 'admin.tasks') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    cookie: response.headers['set-cookie'].split(';')[0],
    'x-csrf-token': response.json().data.csrfToken,
  };
}
function create(identity, options = {}) {
  const { target = app, payload = body, key = randomUUID(), headers = {} } = options;
  return target.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    payload,
    headers: Object.fromEntries(
      Object.entries({
        origin,
        'idempotency-key': key,
        ...identity,
        ...headers,
      }).filter(([, value]) => value !== undefined),
    ),
  });
}
function detail(identity, taskId, options = {}) {
  const { target = app, headers = {} } = options;
  return target.inject({
    method: 'GET',
    url: `/api/v1/tasks/${taskId}`,
    // Reads require the session only, without Origin, CSRF or an action key.
    headers: { ...(identity?.cookie ? { cookie: identity.cookie } : {}), ...headers },
  });
}
function list(identity, query = {}) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/tasks?' + new URLSearchParams(query),
    headers: identity?.cookie ? { cookie: identity.cookie } : {},
  });
}

test('列表读取真实同团队历史，包含未执行草稿，不泄露其他团队且不写入数据', async () => {
  const identity = await login();
  const first = (await create(identity)).json().data;
  await insertMember(teamId, 'peer.tasks');
  const peer = await login('peer.tasks');
  const second = (await create(peer, { payload: { ...body, title: '同团队成员任务' } })).json()
    .data;
  const otherTeam = (await client.query("INSERT INTO teams(name) VALUES ('other') RETURNING id"))
    .rows[0].id;
  await insertMember(otherTeam, 'other.tasks');
  await create(await login('other.tasks'));
  const before = await fingerprint();
  const response = await list(identity);
  assert.equal(response.statusCode, 200, response.body);
  const page = response.json().data;
  assert.deepEqual(
    new Set(page.items.map((i) => i.task.id)),
    new Set([first.task.id, second.task.id]),
  );
  assert.equal(page.nextCursor, null);
  assert.ok(page.items.every((i) => i.execution === null && i.task.teamId === teamId));
  assert.ok(!response.body.includes('private-credential-reference'));
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(spec, 'contract');
  const validate = ajv.compile({ $ref: 'contract#/components/schemas/Tasks' });
  assert.ok(validate(page), JSON.stringify(validate.errors));
  assert.deepEqual(await fingerprint(), before);
  assert.equal((await list(null)).statusCode, 401);
});

test('搜索标题和编号为字面子串，状态与搜索按 AND 组合，旧执行状态正确映射', async () => {
  const identity = await login();
  const a = (await create(identity, { payload: { ...body, title: '折扣100%_\\活动' } })).json().data
    .task.id;
  const b = (await create(identity, { payload: { ...body, title: '普通活动' } })).json().data.task
    .id;
  await client.query("UPDATE tasks SET execution_status='running' WHERE id=$1", [a]);
  await client.query("UPDATE tasks SET execution_status='needs_human' WHERE id=$1", [b]);
  for (const q of ['100%_', '%_\\', a.slice(0, 10)]) {
    const response = await list(identity, { q });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().data.items.map((i) => i.task.id),
      [a],
    );
  }
  assert.equal((await list(identity, { q: "' OR 1=1 --" })).json().data.items.length, 0);
  assert.equal(
    (await list(identity, { q: '普通', execution: 'running' })).json().data.items.length,
    0,
  );
  assert.equal((await list(identity, { execution: 'running' })).json().data.items[0].task.id, a);
  assert.equal(
    (await list(identity, { execution: 'manual_required' })).json().data.items[0].execution,
    'manual_required',
  );
  for (const query of [
    { approval: 'pending' },
    { publication: 'published' },
    { lifecycle: 'terminated' },
  ])
    assert.deepEqual((await list(identity, query)).json().data, { items: [], nextCursor: null });
});

test('游标保留微秒与同时间编号排序，分页无重复遗漏，并拒绝无效游标和参数', async () => {
  const identity = await login();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await create(identity)).json().data.task.id);
  await client.query("UPDATE tasks SET updated_at='2026-10-29T00:00:00.123456Z'");
  await client.query("UPDATE tasks SET updated_at='2026-10-29T00:00:00.123789Z' WHERE id=$1", [
    ids[0],
  ]);
  const expected = (
    await client.query('SELECT id FROM tasks ORDER BY updated_at DESC,id DESC')
  ).rows.map((r) => r.id);
  const seen = [];
  let cursor;
  do {
    const response = await list(identity, { limit: '2', ...(cursor ? { cursor } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    seen.push(...response.json().data.items.map((i) => i.task.id));
    cursor = response.json().data.nextCursor;
  } while (cursor && seen.length < 10);
  assert.deepEqual(seen, expected);
  const first = (await list(identity, { limit: '1' })).json().data;
  for (const query of [
    { cursor: 'invalid' },
    { cursor: first.nextCursor, q: 'changed' },
    { limit: '0' },
    { limit: '101' },
    { execution: 'invalid' },
  ])
    assert.equal((await list(identity, query)).statusCode, 400, JSON.stringify(query));
});
async function fingerprint() {
  const result = {};
  for (const name of [
    'tasks',
    'teams',
    'members',
    'accounts',
    'sessions',
    'audit_events',
    'idempotency_records',
    'execution_attempts',
    'execution_steps',
    'task_contents',
    'clarification_answers',
  ]) {
    result[name] = (
      await client.query(
        `SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) AS hash FROM public."${name}" t`,
      )
    ).rows[0].hash;
  }
  return result;
}
async function counts() {
  return (
    await client.query(`SELECT
    (SELECT count(*)::int FROM tasks) AS tasks,
    (SELECT count(*)::int FROM idempotency_records WHERE response_status=201) AS replays,
    (SELECT count(*)::int FROM audit_events WHERE action='task.created') AS audits`)
  ).rows[0];
}
async function insertMember(team, login, role = 'operator') {
  return (
    await client.query(
      `INSERT INTO members
    (team_id,login,password_hash,display_name,role,password_changed_at)
    VALUES ($1,$2,$3,$2,$4,$5) RETURNING id`,
      [team, login, storedHash, role, new Date(now.getTime() - 1000)],
    )
  ).rows[0].id;
}
before(async () => {
  await client.connect();
  await runMigrations(client, 'migrate');
  storedHash = await hashPassword(password);
  const appPassword = randomBytes(24).toString('hex');
  await client.query(
    `CREATE ROLE "${appRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}'`,
  );
  await client.query(`GRANT "${appRole}" TO CURRENT_USER`);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${appRole}"`);
  await client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${appRole}"`,
  );
  appUrl = new URL(rawUrl);
  appUrl.username = appRole;
  appUrl.password = appPassword;
  database = createBusinessDatabase(appUrl.href);
});
beforeEach(async () => {
  if (app) await app.close();
  await client.query('TRUNCATE teams,idempotency_records,tasks CASCADE');
  now = new Date();
  teamId = (
    await client.query("INSERT INTO teams(name) VALUES ('synthetic tasks team') RETURNING id")
  ).rows[0].id;
  memberId = await insertMember(teamId, 'admin.tasks', 'admin');
  accountId = (
    await client.query(
      `INSERT INTO accounts(team_id,display_name,credential_ref)
    VALUES ($1,'Synthetic Weibo','private-credential-reference') RETURNING id`,
      [teamId],
    )
  ).rows[0].id;
  app = application();
});
after(async () => {
  if (app) await app.close();
  if (database) await database.close();
  await client.query(`DROP OWNED BY "${appRole}"`);
  await client.query(`DROP ROLE "${appRole}"`);
  await client.end();
});

test('创建遵循已有 201 契约，原文、创建人、团队、固定账号和参考资料真实保存且不执行', async () => {
  const identity = await login();
  const response = await create(identity);
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  const data = result.data;
  assert.equal(result.meta.replayed, false);
  assert.ok(result.meta.requestId);
  assert.equal(data.task.title, body.title);
  assert.equal(data.task.originalRequest, body.originalRequest);
  assert.equal(data.task.teamId, teamId);
  assert.equal(data.task.createdBy, memberId);
  assert.equal(data.task.accountId, accountId);
  assert.equal(data.task.lifecycle, 'open');
  assert.equal(data.task.revision, 1);
  assert.equal(data.task.referenceInputs.length, 1);
  assert.ok(data.task.referenceInputs[0].id);
  assert.equal(data.task.referenceInputs[0].url, body.referenceInputs[0].url);
  assert.equal(data.task.referenceInputs[0].label, body.referenceInputs[0].label);
  assert.deepEqual(data.task.clarifications, []);
  for (const name of [
    'currentAttemptId',
    'currentContentVersionId',
    'currentReviewCycleId',
    'currentApprovalId',
    'activePublishOperationId',
    'publishedOperationId',
    'sourceTaskId',
  ])
    assert.equal(data.task[name], null, name);
  for (const name of [
    'execution',
    'currentStep',
    'currentAttempt',
    'currentContent',
    'currentReview',
    'currentApproval',
    'currentPublication',
    'latestReflection',
    'workLock',
  ])
    assert.equal(data[name], null, name);
  assert.equal(data.approval, 'not_requested');
  assert.equal(data.publication, 'not_published');
  assert.equal(data.actions.start.allowed, true);
  assert.ok(
    Object.entries(data.actions)
      .filter(([name]) => name !== 'start')
      .every(([, a]) => !a.allowed && a.reason),
  );
  const row = (await client.query('SELECT * FROM tasks WHERE id=$1', [data.task.id])).rows[0];
  assert.equal(row.original_request, body.originalRequest);
  assert.equal(row.created_by, memberId);
  assert.equal(row.team_id, teamId);
  assert.equal(row.account_id, accountId);
  assert.deepEqual(row.reference_inputs, data.task.referenceInputs);
  assert.equal(row.execution_status, null);
  assert.equal(row.current_step, null);
  assert.equal(row.error_message, null);
  const audit = (await client.query("SELECT * FROM audit_events WHERE action='task.created'"))
    .rows[0];
  assert.equal(audit.actor_id, memberId);
  assert.equal(audit.team_id, teamId);
  assert.equal(audit.target_id, row.id);
  assert.equal(audit.request_id, result.meta.requestId);
  assert.equal(audit.after_revision, 1);
  assert.equal(audit.outcome, 'succeeded');
  assert.ok(!response.body.includes('private-credential-reference'));
  assert.equal(response.headers['cache-control'], 'no-store');
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const operation = spec.paths['/api/v1/tasks'].post;
  assert.equal(operation['x-implementation'], 'implemented');
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile({
    components: spec.components,
    ...operation.responses['201'].content['application/json'].schema,
  });
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
});

test('重复提交、并发请求和服务重建均重放同一任务，参考资料 ID 保持稳定', async () => {
  const identity = await login();
  const key = randomUUID();
  const secondDatabase = createBusinessDatabase(appUrl.href);
  const secondApp = application({ tasks: new TaskService(secondDatabase.db, () => new Date(now)) });
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        create(identity, { key, target: index % 2 ? secondApp : app }),
      ),
    );
    for (const r of results) assert.equal(r.statusCode, 201, r.body);
    const data = results[0].json().data;
    assert.equal(results.filter((r) => !r.json().meta.replayed).length, 1);
    for (const r of results) assert.deepEqual(r.json().data, data);
    await app.close();
    app = application();
    const replay = await create(identity, { key });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().meta.replayed, true);
    assert.deepEqual(replay.json().data, data);
    assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
    const record = (
      await client.query('SELECT * FROM idempotency_records WHERE response_status=201')
    ).rows[0];
    assert.equal(record.expires_at - record.created_at, 24 * 60 * 60 * 1000);
    assert.notEqual(record.key_hash, key);
  } finally {
    await secondApp.close();
    await secondDatabase.close();
  }
});

test('同键不同输入拒绝，JSON 对象键序变化与省略空参考资料可重放', async () => {
  const identity = await login();
  const key = randomUUID();
  const first = await create(identity, { key });
  for (const payload of [
    { ...body, title: '不同标题' },
    { ...body, originalRequest: body.originalRequest.trim() },
    { ...body, referenceInputs: [{ label: '不同资料', url: body.referenceInputs[0].url }] },
  ]) {
    const r = await create(identity, { key, payload });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  }
  const reordered = await create(identity, {
    key,
    payload: {
      referenceInputs: [{ url: body.referenceInputs[0].url, label: body.referenceInputs[0].label }],
      originalRequest: body.originalRequest,
      title: body.title,
    },
  });
  assert.equal(reordered.json().meta.replayed, true);
  assert.deepEqual(reordered.json().data, first.json().data);
  const emptyKey = randomUUID();
  const minimal = { title: body.title, originalRequest: body.originalRequest };
  assert.equal((await create(identity, { key: emptyKey, payload: minimal })).statusCode, 201);
  assert.equal(
    (await create(identity, { key: emptyKey, payload: { ...minimal, referenceInputs: [] } })).json()
      .meta.replayed,
    true,
  );
  assert.deepEqual(await counts(), { tasks: 2, replays: 2, audits: 2 });
});

test('缺字段、空白、超长、非法参考资料及客户端伪造归属或状态均拒绝且不消费键', async () => {
  const identity = await login();
  for (const payload of [
    {},
    { title: '标题' },
    { originalRequest: '要求' },
    { ...body, title: ' \t\n' },
    { ...body, originalRequest: '　\r\n' },
    { ...body, title: 'x'.repeat(121) },
    { ...body, originalRequest: 'x'.repeat(10001) },
    { ...body, referenceInputs: [{ label: '资料', url: 'not a URI' }] },
    { ...body, referenceInputs: [{ label: ' ', url: 'https://example.com' }] },
    { ...body, createdBy: randomUUID() },
    { ...body, teamId: randomUUID() },
    { ...body, accountId: randomUUID() },
    { ...body, executionStatus: 'running' },
    { ...body, lifecycle: 'published' },
    { ...body, revision: 20 },
  ]) {
    const response = await create(identity, { payload, key: 'validation-not-consumed' });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  }
  for (const key of [undefined, 'short']) {
    const response = await create(identity, { headers: { 'idempotency-key': key } });
    assert.equal(response.statusCode, 400, response.body);
  }
  const malformed = await create(identity, {
    payload: '{broken-json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(await counts(), { tasks: 0, replays: 0, audits: 0 });
  assert.equal((await create(identity, { key: 'validation-not-consumed' })).statusCode, 201);
});

test('未登录、错误 Origin/CSRF 及已禁用身份不能创建或重放任务', async () => {
  const key = randomUUID();
  const missing = await create({}, { key });
  assert.equal(missing.statusCode, 401);
  const identity = await login();
  assert.equal((await create(identity, { key })).statusCode, 201);
  for (const headers of [
    { origin: undefined },
    { origin: 'https://evil.example' },
    { 'x-csrf-token': undefined },
    { 'x-csrf-token': 'forged' },
  ])
    assert.equal((await create(identity, { key, headers })).statusCode, 403);
  await client.query("UPDATE members SET status='disabled' WHERE id=$1", [memberId]);
  assert.equal((await create(identity, { key })).statusCode, 401);
  assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
});

test('动作键按团队和操作者隔离，运营成员可创建且伪造身份头无效', async () => {
  const admin = await login();
  const operatorId = await insertMember(teamId, 'operator.tasks');
  const operator = await login('operator.tasks');
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  const otherMember = await insertMember(otherTeam, 'other.tasks');
  const otherAccount = (
    await client.query(
      "INSERT INTO accounts(team_id,display_name) VALUES ($1,'Other account') RETURNING id",
      [otherTeam],
    )
  ).rows[0].id;
  const other = await login('other.tasks');
  const key = randomUUID();
  const first = await create(admin, { key });
  const second = await create(operator, {
    key,
    headers: { 'x-member-id': memberId, 'x-team-id': otherTeam, 'x-role': 'admin' },
  });
  const third = await create(other, { key });
  for (const r of [first, second, third]) {
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().meta.replayed, false);
  }
  assert.equal(second.json().data.task.createdBy, operatorId);
  assert.equal(second.json().data.task.teamId, teamId);
  assert.equal(second.json().data.task.accountId, accountId);
  assert.equal(third.json().data.task.createdBy, otherMember);
  assert.equal(third.json().data.task.teamId, otherTeam);
  assert.equal(third.json().data.task.accountId, otherAccount);
  assert.equal(new Set([first, second, third].map((r) => r.json().data.task.id)).size, 3);
  assert.deepEqual(await counts(), { tasks: 3, replays: 3, audits: 3 });
});

test('无账号可先创建草稿，不借用其他团队账号；后续配置账号不改变原创建重放', async () => {
  const identity = await login();
  await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  await client.query("INSERT INTO accounts(team_id,display_name) VALUES ($1,'Other account')", [
    otherTeam,
  ]);
  const key = randomUUID();
  const created = await create(identity, { key });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.task.accountId, null);
  assert.equal(created.json().data.account, null);
  assert.equal(created.json().data.execution, null);
  assert.equal(created.json().data.currentAttempt, null);
  const row = (await client.query('SELECT * FROM tasks WHERE id=$1', [created.json().data.task.id]))
    .rows[0];
  assert.equal(row.account_id, null);
  assert.equal(row.created_by, memberId);
  assert.equal(row.team_id, teamId);
  assert.equal(row.original_request, body.originalRequest);
  assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile({
    components: spec.components,
    ...spec.paths['/api/v1/tasks'].post.responses['201'].content['application/json'].schema,
  });
  assert.equal(validate(created.json()), true, JSON.stringify(validate.errors));
  const fixed = (
    await client.query(
      "INSERT INTO accounts(team_id,display_name) VALUES ($1,'Fixed account') RETURNING id",
      [teamId],
    )
  ).rows[0].id;
  await app.close();
  app = application();
  const replay = await create(identity, { key });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().meta.replayed, true);
  assert.deepEqual(replay.json().data, created.json().data);
  assert.equal(
    (await client.query('SELECT account_id FROM tasks WHERE id=$1', [row.id])).rows[0].account_id,
    null,
  );
  const accepted = await create(identity);
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().data.task.accountId, fixed);
  assert.deepEqual(await counts(), { tasks: 2, replays: 2, audits: 2 });
});

test('无账号并发重复创建也只保存一条未绑定任务', async () => {
  await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  const identity = await login();
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 5 }, () => create(identity, { key })));
  for (const response of responses) {
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().data.task.accountId, null);
    assert.equal(response.json().data.account, null);
  }
  assert.equal(new Set(responses.map((r) => r.json().data.task.id)).size, 1);
  assert.equal(responses.filter((r) => !r.json().meta.replayed).length, 1);
  assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
});

test('审计失败回滚任务和幂等记录，恢复后复用原键可创建', async () => {
  const identity = await login();
  const key = randomUUID();
  await client.query(`CREATE FUNCTION tasks_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='task.created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
  await client.query(
    'CREATE TRIGGER tasks_test_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION tasks_test_audit_failure()',
  );
  try {
    const failed = await create(identity, { key });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(failed.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(failed.json().error.retryable, true);
    assert.ok(!failed.body.includes('synthetic audit failure'));
    assert.ok(!failed.body.includes(body.originalRequest));
    assert.deepEqual(await counts(), { tasks: 0, replays: 0, audits: 0 });
  } finally {
    await client.query('DROP TRIGGER tasks_test_audit_failure ON audit_events');
    await client.query('DROP FUNCTION tasks_test_audit_failure()');
  }
  assert.equal((await create(identity, { key })).statusCode, 201);
});

test('数据库故障返回安全的 503，原始要求和凭据不进入响应或日志', async () => {
  const identity = await login();
  const badUrl = new URL(appUrl);
  badUrl.port = '1';
  const broken = createBusinessDatabase(badUrl.href);
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const unavailable = application({
    tasks: new TaskService(broken.db),
    logging: true,
    logStream: stream,
  });
  try {
    const response = await create(identity, { target: unavailable });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    for (const secret of [
      badUrl.href,
      appUrl.password,
      body.originalRequest,
      identity.cookie,
      identity['x-csrf-token'],
    ]) {
      assert.ok(!response.body.includes(secret));
      assert.ok(!logs.includes(secret));
    }
    assert.deepEqual(await counts(), { tasks: 0, replays: 0, audits: 0 });
    const readFailure = await detail(identity, randomUUID(), { target: unavailable });
    assert.equal(readFailure.statusCode, 503, readFailure.body);
    assert.equal(readFailure.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(readFailure.json().error.retryable, true);
    for (const secret of [
      badUrl.href,
      appUrl.password,
      identity.cookie,
      identity['x-csrf-token'],
    ]) {
      assert.ok(!readFailure.body.includes(secret));
      assert.ok(!logs.includes(secret));
    }
  } finally {
    await unavailable.close();
    await broken.close();
    stream.end();
  }
});

test('重放重新验证原任务归属，不跨团队泄漏已迁移任务', async () => {
  const identity = await login();
  const key = randomUUID();
  const first = await create(identity, { key });
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  await client.query('UPDATE tasks SET team_id=$1 WHERE id=$2', [
    otherTeam,
    first.json().data.task.id,
  ]);
  const response = await create(identity, { key });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.json().error.code, 'NOT_FOUND');
  assert.deepEqual(await counts(), { tasks: 1, replays: 1, audits: 1 });
});

test('冲突要求原样保存，创建阶段不澄清、不生成；新动作键表示另一项创建意图', async () => {
  const identity = await login();
  const payload = { title: '冲突要求', originalRequest: '要求恰好100字，同时必须恰好200字。' };
  const first = await create(identity, { payload });
  const second = await create(identity, { payload });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().data.task.originalRequest, payload.originalRequest);
  assert.equal(first.json().data.currentAttempt, null);
  assert.equal(first.json().data.execution, null);
  assert.equal(second.statusCode, 201, second.body);
  assert.notEqual(first.json().data.task.id, second.json().data.task.id);
});

test('详情查询返回 200 完整契约，原文、创建人、账号及参考资料与创建结果一致', async () => {
  const identity = await login();
  const created = await create(identity);
  const expected = created.json().data;
  const before = await fingerprint();
  const response = await detail(identity, expected.task.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, expected);
  assert.equal(response.json().meta.replayed, false);
  assert.ok(response.json().meta.requestId);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.pragma, 'no-cache');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.json().data.errorMessage, null);
  assert.ok(!response.body.includes('private-credential-reference'));
  assert.ok(!response.body.includes(storedHash));
  assert.deepEqual(await fingerprint(), before);
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const operation = spec.paths['/api/v1/tasks/{taskId}'].get;
  assert.equal(operation['x-implementation'], 'implemented');
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile({
    components: spec.components,
    ...operation.responses['200'].content['application/json'].schema,
  });
  assert.equal(validate(response.json()), true, JSON.stringify(validate.errors));
});

test('刷新及服务重建读取当前数据库状态，不使用创建时的幂等响应缓存', async () => {
  const identity = await login();
  const key = randomUUID();
  const created = await create(identity, { key });
  const id = created.json().data.task.id;
  const changedAt = new Date(now.getTime() + 1000);
  await client.query(
    `UPDATE tasks SET title='更新后的标题',revision=2,updated_at=$1,
    execution_status='failed',current_step='research',error_message='检索暂时失败' WHERE id=$2`,
    [changedAt, id],
  );
  await app.close();
  const restartedDatabase = createBusinessDatabase(appUrl.href);
  app = application({ tasks: new TaskService(restartedDatabase.db) });
  try {
    const before = await fingerprint();
    for (let i = 0; i < 2; i++) {
      const response = await detail(identity, id);
      assert.equal(response.statusCode, 200, response.body);
      const data = response.json().data;
      assert.equal(data.task.title, '更新后的标题');
      assert.equal(data.task.originalRequest, body.originalRequest);
      assert.deepEqual(data.task.referenceInputs, created.json().data.task.referenceInputs);
      assert.equal(data.task.revision, 2);
      assert.equal(data.task.updatedAt, changedAt.toISOString());
      assert.equal(data.execution, 'failed');
      assert.equal(data.currentStep, 'research');
      assert.equal(data.errorMessage, '检索暂时失败');
      assert.equal(data.currentAttempt, null);
    }
    assert.deepEqual(await fingerprint(), before);
    const replay = await create(identity, { key });
    assert.deepEqual(replay.json().data, created.json().data);
  } finally {
    await app.close();
    await restartedDatabase.close();
  }
});

test('同团队运营成员可查看他人创建的任务，创建人仍为原成员', async () => {
  const admin = await login();
  const first = (await create(admin)).json().data;
  const operatorId = await insertMember(teamId, 'reader.tasks');
  const operator = await login('reader.tasks');
  const read = await detail(operator, first.task.id);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().data.task.createdBy, memberId);
  const second = (await create(operator)).json().data;
  const adminRead = await detail(admin, second.task.id);
  assert.equal(adminRead.statusCode, 200, adminRead.body);
  assert.equal(adminRead.json().data.task.createdBy, operatorId);
});

test('跨团队、任务不存在及非 UUID 标识统一 404，伪造身份头不能越权', async () => {
  const admin = await login();
  const created = (await create(admin)).json().data;
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  await insertMember(otherTeam, 'outsider.tasks');
  const outsider = await login('outsider.tasks');
  const before = await fingerprint();
  const cross = await detail(outsider, created.task.id, {
    headers: {
      'x-team-id': teamId,
      'x-member-id': memberId,
      'x-role': 'admin',
    },
  });
  assert.equal(cross.statusCode, 404, cross.body);
  assert.equal(cross.json().error.code, 'NOT_FOUND');
  for (const id of [randomUUID(), 'task-does-not-exist', 'x'.repeat(128)]) {
    const missing = await detail(admin, id);
    assert.equal(missing.statusCode, 404, missing.body);
    assert.deepEqual(missing.json().error, cross.json().error);
  }
  assert.ok(!cross.body.includes(created.task.title));
  assert.ok(!cross.body.includes(body.originalRequest));
  assert.deepEqual(await fingerprint(), before);
});

test('读取先验证登录，禁用、撤销会话后不能查询已创建任务', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  for (const target of [id, 'not-a-uuid']) {
    const response = await detail(null, target);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');
  }
  await client.query("UPDATE members SET status='disabled' WHERE id=$1", [memberId]);
  assert.equal((await detail(identity, id)).statusCode, 401);
  await client.query("UPDATE members SET status='active' WHERE id=$1", [memberId]);
  const logout = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { origin, ...identity },
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.equal((await detail(identity, id)).statusCode, 401);
});

test('无账号任务可查询，之后配置团队账号也不会隐式绑定历史草稿', async () => {
  await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  const identity = await login();
  const created = (await create(identity)).json().data;
  const first = await detail(identity, created.task.id);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.account, null);
  assert.equal(first.json().data.task.accountId, null);
  await client.query("INSERT INTO accounts(team_id,display_name) VALUES ($1,'Later account')", [
    teamId,
  ]);
  const before = await fingerprint();
  const second = await detail(identity, created.task.id);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json().data, first.json().data);
  assert.deepEqual(await fingerprint(), before);
});

test('详情投影持久化执行状态和错误，兼容原型 needs_human 状态', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  for (const status of [
    null,
    'awaiting_clarification',
    'queued',
    'running',
    'needs_human',
    'ready',
    'failed',
    'cancelled',
  ]) {
    await client.query(
      "UPDATE tasks SET execution_status=$1,current_step='drafting',error_message='步骤错误说明' WHERE id=$2",
      [status, id],
    );
    const response = await detail(identity, id);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json().data.execution,
      status === 'needs_human' ? 'manual_required' : status,
    );
    assert.equal(response.json().data.currentStep, 'drafting');
    assert.equal(response.json().data.errorMessage, '步骤错误说明');
    assert.equal(response.json().data.currentAttempt, null);
    assert.equal(response.json().data.actions.start.allowed, status === null);
    assert.ok(
      Object.entries(response.json().data.actions)
        .filter(([name]) => name !== 'start')
        .every(([, action]) => !action.allowed),
    );
  }
});

test('详情查询可以使用只读数据库连接，不写业务行、审计或幂等记录', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  const readUrl = new URL(appUrl);
  readUrl.searchParams.set('options', '-c default_transaction_read_only=on');
  const readDatabase = createBusinessDatabase(readUrl.href);
  const reader = application({
    auth: new AuthService(readDatabase.db, config, { now: () => new Date(now) }),
    tasks: new TaskService(readDatabase.db),
  });
  try {
    const before = await fingerprint();
    const response = await detail(identity, id, { target: reader });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await fingerprint(), before);
  } finally {
    await reader.close();
    await readDatabase.close();
  }
});

test('旧任务不猜测团队或创建人；团队已知但创建人缺失时提示核对', async () => {
  const identity = await login();
  const old = (
    await client.query(
      "INSERT INTO tasks(title,original_request) VALUES ('legacy','legacy request') RETURNING id",
    )
  ).rows[0].id;
  const before = await fingerprint();
  assert.equal((await detail(identity, old)).statusCode, 404);
  assert.deepEqual(await fingerprint(), before);
  await client.query('UPDATE tasks SET team_id=$1 WHERE id=$2', [teamId, old]);
  const incomplete = await detail(identity, old);
  assert.equal(incomplete.statusCode, 409, incomplete.body);
  assert.equal(incomplete.json().error.code, 'INVALID_STATE');
  assert.equal(
    (await client.query('SELECT created_by FROM tasks WHERE id=$1', [old])).rows[0].created_by,
    null,
  );
});

test('任务误绑其他团队账号时拒绝返回账号资料，不自动修复数据', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  const otherAccount = (
    await client.query(
      "INSERT INTO accounts(team_id,display_name,credential_ref) VALUES ($1,'private-other-account','private-other-credential') RETURNING id",
      [otherTeam],
    )
  ).rows[0].id;
  await client.query('UPDATE tasks SET account_id=$1 WHERE id=$2', [otherAccount, id]);
  const before = await fingerprint();
  const response = await detail(identity, id);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'INVALID_STATE');
  for (const secret of [otherAccount, 'private-other-account', 'private-other-credential'])
    assert.ok(!response.body.includes(secret));
  assert.deepEqual(await fingerprint(), before);
});

test('详情错误字段兼容先前保存的创建幂等记录', async () => {
  const identity = await login();
  const key = randomUUID();
  const first = await create(identity, { key });
  await client.query(
    "UPDATE idempotency_records SET response_body=response_body-'errorMessage' WHERE response_status=201",
  );
  const replay = await create(identity, { key });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().meta.replayed, true);
  assert.deepEqual(replay.json().data, first.json().data);
  assert.deepEqual(
    (await detail(identity, first.json().data.task.id)).json().data,
    first.json().data,
  );
});

function execute(identity, taskId, kind, payload, options = {}) {
  const path =
    kind === 'start'
      ? 'attempts'
      : kind === 'retry'
        ? 'attempt-retries'
        : `attempts/${options.attemptId}/stop`;
  return (options.target ?? app).inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/${path}`,
    payload,
    headers: {
      origin,
      'idempotency-key': options.key ?? randomUUID(),
      ...identity,
      ...(options.headers ?? {}),
    },
  });
}
function history(identity, taskId, query = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${taskId}/history?${new URLSearchParams(query)}`,
    headers: identity?.cookie ? { cookie: identity.cookie } : {},
  });
}
async function advance(worker, times = 1) {
  for (let i = 0; i < times; i++) {
    now = new Date(now.getTime() + 1000);
    assert.equal(await worker.tick(), true);
  }
}

test('模拟首次启动冻结输入，真实保存排队记录与四个步骤，符合 202 和历史契约', async () => {
  const identity = await login();
  const created = (await create(identity)).json().data;
  const response = await execute(identity, created.task.id, 'start', { expectedRevision: 1 });
  assert.equal(response.statusCode, 202, response.body);
  const data = response.json().data;
  assert.equal(data.execution, 'queued');
  assert.equal(data.task.revision, 2);
  assert.equal(data.currentAttempt.attemptNo, 1);
  assert.equal(data.currentAttempt.executorMode, 'mock');
  assert.equal(data.currentAttempt.simulationScenario, 'success');
  assert.equal(data.currentAttempt.startedAt, null);
  assert.equal(data.workLock.ownerId, data.currentAttempt.id);
  assert.equal(data.actions.start.allowed, false);
  assert.equal(data.actions.stop.allowed, true);
  const row = (await client.query('SELECT * FROM execution_attempts')).rows[0];
  assert.equal(row.config_snapshot.originalRequest, body.originalRequest);
  assert.equal(row.config_snapshot.inputRevision, 1);
  const result = await history(identity, created.task.id);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().data.attempts.length, 1);
  assert.equal(result.json().data.steps.length, 4);
  assert.ok(result.json().data.steps.every((step) => step.status === 'queued'));
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(spec, 'execution-contract');
  for (const [model, value] of [
    ['TaskDetail', data],
    ['History', result.json().data],
  ]) {
    const validate = ajv.compile({ $ref: `execution-contract#/components/schemas/${model}` });
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
  for (const secret of ['passwordHash', 'credentialRef', 'configSnapshot'])
    assert.ok(!result.body.includes(secret));
});

test('并发启动、同键重放与服务重建只产生一次尝试；不同请求复用键被拒绝', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  const key = randomUUID();
  const payload = { expectedRevision: 1, simulationScenario: 'success' };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => execute(identity, id, 'start', payload, { key })),
  );
  assert.ok(
    responses.every((response) => response.statusCode === 202),
    responses.map((r) => r.body).join('\n'),
  );
  assert.equal(responses.filter((r) => !r.json().meta.replayed).length, 1);
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    1,
  );
  const restarted = application();
  try {
    assert.equal(
      (await execute(identity, id, 'start', payload, { key, target: restarted })).json().meta
        .replayed,
      true,
    );
  } finally {
    await restarted.close();
  }
  const different = await execute(
    identity,
    id,
    'start',
    { ...payload, simulationScenario: 'failure' },
    { key },
  );
  assert.equal(different.statusCode, 409);
  assert.equal(different.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(
    (await execute(identity, id, 'start', payload)).json().error.code,
    'REVISION_CONFLICT',
  );
  assert.equal(
    (await execute(identity, id, 'start', { expectedRevision: 2 })).json().error.code,
    'WORK_LOCKED',
  );
});

test('模拟成功逐步推进；刷新、执行器重建和双工作进程不会重复产出或覆盖旧步骤', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', { expectedRevision: 1 });
  let worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  assert.equal(await worker.tick(), false);
  await advance(worker);
  const running = (await detail(identity, id)).json().data;
  assert.equal(running.execution, 'running');
  assert.ok(running.currentAttempt.startedAt);
  worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  for (let i = 0; i < 4; i++) {
    now = new Date(now.getTime() + 1000);
    const another = new MockTaskExecutor(database.db, { now: () => new Date(now) });
    const results = await Promise.all([worker.tick(), another.tick()]);
    assert.equal(results.filter(Boolean).length, 1);
  }
  const ready = (await detail(identity, id)).json().data;
  assert.equal(ready.execution, 'ready');
  assert.equal(ready.workLock, null);
  assert.ok(ready.currentAttempt.finishedAt);
  assert.ok(ready.currentContent.body.startsWith('【模拟产出'));
  assert.ok(ready.currentContent.body.includes(body.originalRequest));
  assert.equal(ready.approval, 'not_requested');
  assert.equal(ready.publication, 'not_published');
  assert.equal(ready.actions.publish.allowed, false);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM task_contents')).rows[0].n, 1);
  const records = (await history(identity, id)).json().data;
  assert.ok(records.steps.every((step) => step.status === 'completed' && step.durationMs === 1000));
  assert.equal(records.audit.items.filter((event) => event.action === 'attempt.ready').length, 1);
  assert.equal(await worker.tick(), false);
});

test('模拟失败保存步骤错误；重试从头新增尝试，旧失败记录及输入保持不变', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', { expectedRevision: 1, simulationScenario: 'failure' });
  const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  await advance(worker, 3);
  const failed = (await detail(identity, id)).json().data;
  assert.equal(failed.execution, 'failed');
  assert.equal(failed.currentAttempt.error.code, 'MOCK_RESEARCH_FAILED');
  assert.ok(failed.errorMessage.includes('模拟执行失败'));
  assert.equal(failed.currentContent, null);
  const before = (await client.query('SELECT * FROM execution_attempts ORDER BY attempt_no')).rows;
  const firstSteps = (await client.query('SELECT * FROM execution_steps ORDER BY ordinal')).rows;
  const key = randomUUID();
  const payload = {
    expectedRevision: failed.task.revision,
    previousAttemptId: failed.currentAttempt.id,
    restartTerminated: false,
    reason: '验证从头重试',
    simulationScenario: 'success',
  };
  const retried = await execute(identity, id, 'retry', payload, { key });
  assert.equal(retried.statusCode, 202, retried.body);
  assert.equal(retried.json().data.currentAttempt.attemptNo, 2);
  assert.equal((await execute(identity, id, 'retry', payload, { key })).json().meta.replayed, true);
  await advance(worker, 5);
  assert.deepEqual(
    (await client.query('SELECT * FROM execution_attempts WHERE id=$1', [before[0].id])).rows,
    before,
  );
  assert.deepEqual(
    (
      await client.query('SELECT * FROM execution_steps WHERE attempt_id=$1 ORDER BY ordinal', [
        before[0].id,
      ])
    ).rows,
    firstSteps,
  );
  const result = (await history(identity, id)).json().data;
  assert.deepEqual(
    result.attempts.map((a) => a.attemptNo),
    [2, 1],
  );
  assert.equal(result.steps.length, 8);
  assert.equal((await detail(identity, id)).json().data.task.originalRequest, body.originalRequest);
});

test('待澄清持久化关联问题且停止调度，重复启动/重试均不能绕过生成阻断', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', {
    expectedRevision: 1,
    simulationScenario: 'clarification',
  });
  const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  await advance(worker, 2);
  const waiting = (await detail(identity, id)).json().data;
  assert.equal(waiting.execution, 'awaiting_clarification');
  assert.equal(waiting.task.clarifications.length, 1);
  assert.equal(waiting.task.clarifications[0].answer, null);
  const before = await fingerprint();
  now = new Date(now.getTime() + 60000);
  assert.equal(await new MockTaskExecutor(database.db, { now: () => new Date(now) }).tick(), false);
  assert.deepEqual(await fingerprint(), before);
  assert.equal(
    (await execute(identity, id, 'start', { expectedRevision: waiting.task.revision })).statusCode,
    423,
  );
  assert.equal(
    (
      await execute(identity, id, 'retry', {
        expectedRevision: waiting.task.revision,
        previousAttemptId: waiting.currentAttempt.id,
        restartTerminated: false,
        reason: '不能绕过',
      })
    ).statusCode,
    423,
  );
  assert.equal((await client.query('SELECT count(*)::int AS n FROM task_contents')).rows[0].n, 0);
});

test('停止模拟执行与旧工作代次隔离，重复停止只确认一次，新尝试不会复活旧步骤', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', { expectedRevision: 1 });
  const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  await advance(worker);
  const running = (await detail(identity, id)).json().data;
  const key = randomUUID();
  const payload = { expectedRevision: running.task.revision, reason: '停止验证' };
  const stopped = await execute(identity, id, 'stop', payload, {
    key,
    attemptId: running.currentAttempt.id,
  });
  assert.equal(stopped.statusCode, 202, stopped.body);
  assert.equal(stopped.json().data.execution, 'cancelled');
  assert.equal(stopped.json().data.workLock, null);
  assert.equal(
    (
      await execute(identity, id, 'stop', payload, { key, attemptId: running.currentAttempt.id })
    ).json().meta.replayed,
    true,
  );
  assert.ok(stopped.json().data.currentAttempt.stoppedAt);
  const old = (await client.query('SELECT * FROM execution_steps ORDER BY ordinal')).rows;
  const latest = stopped.json().data;
  await execute(identity, id, 'retry', {
    expectedRevision: latest.task.revision,
    previousAttemptId: latest.currentAttempt.id,
    restartTerminated: false,
    reason: '重新开始',
  });
  await advance(worker, 5);
  assert.deepEqual(
    (
      await client.query('SELECT * FROM execution_steps WHERE attempt_id=$1 ORDER BY ordinal', [
        running.currentAttempt.id,
      ])
    ).rows,
    old,
  );
  assert.equal((await detail(identity, id)).json().data.currentAttempt.attemptNo, 2);
});

test('执行与历史遵守团队、会话、Origin/CSRF 和 revision，查询不写入数据库', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await insertMember(teamId, 'peer.execution');
  const peer = await login('peer.execution');
  assert.equal((await execute(peer, id, 'start', { expectedRevision: 1 })).statusCode, 202);
  const other = (
    await client.query("INSERT INTO teams(name) VALUES ('other execution') RETURNING id")
  ).rows[0].id;
  await insertMember(other, 'other.execution');
  const stranger = await login('other.execution');
  const before = await fingerprint();
  assert.equal((await history(peer, id)).statusCode, 200);
  assert.equal((await history(stranger, id)).statusCode, 404);
  assert.equal((await history(null, id)).statusCode, 401);
  assert.equal((await execute(stranger, id, 'start', { expectedRevision: 2 })).statusCode, 404);
  assert.equal(
    (
      await execute(
        identity,
        id,
        'start',
        { expectedRevision: 2 },
        { headers: { 'x-csrf-token': 'forged' } },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await execute(
        identity,
        id,
        'start',
        { expectedRevision: 2 },
        { headers: { origin: 'https://other.example' } },
      )
    ).statusCode,
    403,
  );
  assert.deepEqual(await fingerprint(), before);
});

test('历史审计分页稳定完整，游标只用于当前团队任务的审计列表', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', { expectedRevision: 1 });
  const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  await advance(worker, 5);
  let cursor;
  const ids = [];
  do {
    const result = await history(identity, id, { limit: '2', ...(cursor ? { cursor } : {}) });
    assert.equal(result.statusCode, 200, result.body);
    const data = result.json().data;
    assert.equal(data.attempts.length, 1);
    assert.equal(data.steps.length, 4);
    ids.push(...data.audit.items.map((e) => e.id));
    cursor = data.audit.nextCursor;
  } while (cursor && ids.length < 20);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  assert.equal((await history(identity, id, { cursor: 'bad' })).statusCode, 400);
  const next = (await history(identity, id, { limit: '1' })).json().data.audit.nextCursor;
  const otherId = (await create(identity)).json().data.task.id;
  assert.equal((await history(identity, otherId, { cursor: next })).statusCode, 400);
});

test('模拟执行器关闭时禁止启动，任务和执行数据不改变', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  const disabled = application({
    tasks: new TaskService(database.db, () => new Date(now), { executorMode: 'disabled' }),
  });
  try {
    const before = await fingerprint();
    assert.equal(
      (await detail(identity, id, { target: disabled })).json().data.actions.start.allowed,
      false,
    );
    assert.equal(
      (await execute(identity, id, 'start', { expectedRevision: 1 }, { target: disabled }))
        .statusCode,
      409,
    );
    assert.deepEqual(await fingerprint(), before);
  } finally {
    await disabled.close();
  }
});

test('执行命令和工作步骤的审计失败均整笔回滚，恢复后原命令与检查点可重试', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  const key = randomUUID();
  await client.query(`CREATE FUNCTION execution_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action=TG_ARGV[0] THEN RAISE EXCEPTION 'synthetic execution audit failure'; END IF; RETURN NEW; END; $$`);
  try {
    await client.query(
      "CREATE TRIGGER execution_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION execution_audit_failure('attempt.started')",
    );
    const before = await fingerprint();
    const failed = await execute(identity, id, 'start', { expectedRevision: 1 }, { key });
    assert.equal(failed.statusCode, 503);
    assert.ok(!failed.body.includes('synthetic execution audit failure'));
    assert.deepEqual(await fingerprint(), before);
    await client.query('DROP TRIGGER execution_audit_failure ON audit_events');
    assert.equal(
      (await execute(identity, id, 'start', { expectedRevision: 1 }, { key })).statusCode,
      202,
    );
    await client.query(
      "CREATE TRIGGER execution_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION execution_audit_failure('attempt.running')",
    );
    now = new Date(now.getTime() + 1000);
    const checkpoint = await fingerprint();
    const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
    await assert.rejects(worker.tick());
    assert.deepEqual(await fingerprint(), checkpoint);
    await client.query('DROP TRIGGER execution_audit_failure ON audit_events');
    assert.equal(await worker.tick(), true);
    assert.equal((await detail(identity, id)).json().data.execution, 'running');
  } finally {
    await client.query('DROP TRIGGER IF EXISTS execution_audit_failure ON audit_events');
    await client.query('DROP FUNCTION execution_audit_failure()');
  }
});

test('模拟工作进程被强制中断后，新进程从数据库检查点恢复并只完成一次', async () => {
  const identity = await login();
  const id = (await create(identity)).json().data.task.id;
  await execute(identity, id, 'start', { expectedRevision: 1 });
  await client.query(
    'UPDATE execution_attempts SET next_run_at=CURRENT_TIMESTAMP WHERE task_id=$1',
    [id],
  );
  const children = [];
  const spawnWorker = async () => {
    const child = fork(
      fileURLToPath(new URL('../tests/fixtures/mock-executor.mjs', import.meta.url)),
      [],
      {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, TASK_TEST_DATABASE_URL: appUrl.href },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    children.push(child);
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('worker exited before ready');
      }),
    ]);
    return child;
  };
  const waitStatus = async (expected) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const status = (await client.query('SELECT execution_status FROM tasks WHERE id=$1', [id]))
        .rows[0].execution_status;
      if (status === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('worker did not reach ' + expected);
  };
  try {
    const first = await spawnWorker();
    await waitStatus('running');
    const exited = once(first, 'exit');
    first.kill('SIGKILL');
    await exited;
    const checkpoint = (await client.query("SELECT * FROM execution_steps WHERE status='running'"))
      .rows[0];
    assert.equal(checkpoint.role, 'supervisor');
    await spawnWorker();
    await waitStatus('ready');
    const firstStep = (
      await client.query('SELECT * FROM execution_steps WHERE id=$1', [checkpoint.id])
    ).rows[0];
    assert.equal(firstStep.status, 'completed');
    assert.deepEqual(firstStep.started_at, checkpoint.started_at);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM task_contents WHERE task_id=$1', [id]))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE task_id=$1 AND action='attempt.ready'",
          [id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await history(identity, id)).json().data.attempts.length, 1);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
  }
});

async function waitingTask(identity) {
  const id = (await create(identity)).json().data.task.id;
  const response = await execute(identity, id, 'start', {
    expectedRevision: 1,
    simulationScenario: 'clarification',
  });
  assert.equal(response.statusCode, 202, response.body);
  const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
  await advance(worker, 2);
  return { data: (await detail(identity, id)).json().data, worker };
}
function clarify(identity, data, options = {}) {
  return (options.target ?? app).inject({
    method: 'POST',
    url: `/api/v1/tasks/${data.task.id}/clarifications`,
    payload: options.payload ?? {
      expectedRevision: data.task.revision,
      attemptId: data.currentAttempt.id,
      answers: [
        {
          questionId: data.task.clarifications[0].questionId,
          answer: '  主题：新品功能；受众：新用户；以事实为准，无冲突要求。\n',
        },
      ],
    },
    headers: {
      origin,
      'idempotency-key': options.key ?? randomUUID(),
      ...identity,
      ...(options.headers ?? {}),
    },
  });
}

test('澄清答复保存到原任务与当前尝试，恢复同一次执行并保留原始要求、首次开始时间和已完成步骤', async () => {
  const identity = await login();
  const { data, worker } = await waitingTask(identity);
  const supervisor = (await client.query("SELECT * FROM execution_steps WHERE role='supervisor'"))
    .rows[0];
  const response = await clarify(identity, data);
  assert.equal(response.statusCode, 202, response.body);
  const resumed = response.json().data;
  assert.equal(resumed.execution, 'queued');
  assert.equal(resumed.currentAttempt.id, data.currentAttempt.id);
  assert.equal(resumed.currentAttempt.attemptNo, 1);
  assert.equal(resumed.currentAttempt.startedAt, data.currentAttempt.startedAt);
  assert.equal(resumed.task.originalRequest, body.originalRequest);
  const answer = (await client.query('SELECT * FROM clarification_answers')).rows[0];
  assert.equal(answer.task_id, data.task.id);
  assert.equal(answer.attempt_id, data.currentAttempt.id);
  assert.equal(answer.question_id, data.task.clarifications[0].questionId);
  assert.equal(answer.answered_by, memberId);
  assert.equal(resumed.task.clarifications[0].answer, answer.answer);
  assert.ok(answer.answer.startsWith('  '));
  assert.ok(answer.answer.endsWith('\n'));
  await advance(worker, 4);
  const finished = (await detail(identity, data.task.id)).json().data;
  assert.equal(finished.execution, 'ready');
  assert.equal(finished.currentAttempt.id, data.currentAttempt.id);
  assert.equal(finished.currentAttempt.startedAt, data.currentAttempt.startedAt);
  assert.ok(finished.currentContent.body.includes(answer.answer));
  assert.ok(finished.currentContent.body.includes(body.originalRequest));
  assert.deepEqual(
    (await client.query('SELECT * FROM execution_steps WHERE id=$1', [supervisor.id])).rows[0],
    supervisor,
  );
  const records = (await history(identity, data.task.id)).json().data;
  assert.equal(records.attempts.length, 1);
  assert.equal(records.clarificationAnswers[0].answeredBy, memberId);
  assert.equal(records.clarificationAnswers[0].answer, answer.answer);
  const spec = (await app.inject('/api/v1/openapi.json')).json();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(spec, 'clarify-contract');
  for (const [model, value] of [
    ['TaskDetail', finished],
    ['History', records],
  ]) {
    const validate = ajv.compile({ $ref: `clarify-contract#/components/schemas/${model}` });
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
});

test('部分答复仍待澄清且不生成，补齐余下问题后恢复；已保存答复不可覆盖', async () => {
  const identity = await login();
  const { data, worker } = await waitingTask(identity);
  const second = { questionId: randomUUID(), question: '请明确目标受众。', answer: null };
  await client.query('UPDATE execution_attempts SET clarifications=$1::jsonb WHERE id=$2', [
    JSON.stringify([...data.task.clarifications, second]),
    data.currentAttempt.id,
  ]);
  const partial = await clarify(identity, data);
  assert.equal(partial.statusCode, 202, partial.body);
  const waiting = partial.json().data;
  assert.equal(waiting.execution, 'awaiting_clarification');
  now = new Date(now.getTime() + 60000);
  assert.equal(await worker.tick(), false);
  const before = await fingerprint();
  const overwrite = await clarify(identity, waiting, {
    payload: {
      expectedRevision: waiting.task.revision,
      attemptId: waiting.currentAttempt.id,
      answers: [{ questionId: data.task.clarifications[0].questionId, answer: '覆盖旧答复' }],
    },
  });
  assert.equal(overwrite.statusCode, 409);
  assert.deepEqual(await fingerprint(), before);
  const complete = await clarify(identity, waiting, {
    payload: {
      expectedRevision: waiting.task.revision,
      attemptId: waiting.currentAttempt.id,
      answers: [{ questionId: second.questionId, answer: '面向首次接触产品的新用户。' }],
    },
  });
  assert.equal(complete.statusCode, 202, complete.body);
  assert.equal(complete.json().data.execution, 'queued');
  await advance(worker, 4);
  assert.equal((await detail(identity, data.task.id)).json().data.execution, 'ready');
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM clarification_answers')).rows[0].n,
    2,
  );
});

test('并发重复答复、进程重建和响应重放只保存一次，改变答复不能复用原动作键', async () => {
  const identity = await login();
  const { data, worker } = await waitingTask(identity);
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => clarify(identity, data, { key })),
  );
  assert.ok(
    results.every((r) => r.statusCode === 202),
    results.map((r) => r.body).join('\n'),
  );
  assert.equal(results.filter((r) => !r.json().meta.replayed).length, 1);
  await advance(worker, 4);
  const restarted = application();
  try {
    const replay = await clarify(identity, data, { key, target: restarted });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().meta.replayed, true);
  } finally {
    await restarted.close();
  }
  const changed = await clarify(identity, data, {
    key,
    payload: {
      expectedRevision: data.task.revision,
      attemptId: data.currentAttempt.id,
      answers: [{ questionId: data.task.clarifications[0].questionId, answer: '修改后的答复' }],
    },
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM clarification_answers')).rows[0].n,
    1,
  );
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM execution_attempts')).rows[0].n,
    1,
  );
});

test('空白、重复编号、跨问题、旧尝试和伪造归属均不能保存答复或绕过待澄清', async () => {
  const identity = await login();
  const { data } = await waitingTask(identity);
  const base = { expectedRevision: data.task.revision, attemptId: data.currentAttempt.id };
  const questionId = data.task.clarifications[0].questionId;
  const before = await fingerprint();
  for (const payload of [
    { ...base, answers: [] },
    { ...base, answers: [{ questionId, answer: ' \n\t' }] },
    { ...base, answers: [{ questionId, answer: 'a'.repeat(4001) }] },
    {
      ...base,
      answers: [
        { questionId, answer: 'a' },
        { questionId, answer: 'b' },
      ],
    },
    { ...base, answers: [{ questionId: randomUUID(), answer: '跨问题答复' }] },
    { ...base, answers: [{ questionId, answer: '答复', answeredBy: memberId }] },
  ])
    assert.equal(
      (await clarify(identity, data, { payload })).statusCode,
      400,
      JSON.stringify(payload).slice(0, 160),
    );
  assert.equal(
    (
      await clarify(identity, data, {
        payload: { ...base, expectedRevision: 1, answers: [{ questionId, answer: '旧版本' }] },
      })
    ).json().error.code,
    'REVISION_CONFLICT',
  );
  assert.equal(
    (
      await clarify(identity, data, {
        payload: { ...base, attemptId: randomUUID(), answers: [{ questionId, answer: '旧尝试' }] },
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await fingerprint(), before);
});

test('同团队成员可答复但跨团队不可访问，Origin/CSRF 校验及停止后的归属校验生效', async () => {
  const identity = await login();
  const { data } = await waitingTask(identity);
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other clarification') RETURNING id")
  ).rows[0].id;
  await insertMember(otherTeam, 'other.clarify');
  const stranger = await login('other.clarify');
  const before = await fingerprint();
  assert.equal((await clarify(stranger, data)).statusCode, 404);
  assert.equal((await clarify({}, data)).statusCode, 401);
  assert.equal(
    (await clarify(identity, data, { headers: { 'x-csrf-token': 'forged' } })).statusCode,
    403,
  );
  assert.equal(
    (await clarify(identity, data, { headers: { origin: 'https://other.example' } })).statusCode,
    403,
  );
  assert.deepEqual(await fingerprint(), before);
  const peerId = await insertMember(teamId, 'peer.clarify');
  const peer = await login('peer.clarify');
  assert.equal((await clarify(peer, data)).statusCode, 202);
  assert.equal(
    (await client.query('SELECT answered_by FROM clarification_answers')).rows[0].answered_by,
    peerId,
  );
  const latest = (await detail(identity, data.task.id)).json().data;
  await execute(
    identity,
    data.task.id,
    'stop',
    { expectedRevision: latest.task.revision, reason: '停止已恢复的尝试' },
    { attemptId: latest.currentAttempt.id },
  );
  const stopped = (await detail(identity, data.task.id)).json().data;
  assert.equal((await clarify(identity, stopped)).statusCode, 409);
  await execute(identity, data.task.id, 'retry', {
    expectedRevision: stopped.task.revision,
    previousAttemptId: stopped.currentAttempt.id,
    restartTerminated: false,
    reason: '重新验证',
    simulationScenario: 'clarification',
  });
  const next = (await detail(identity, data.task.id)).json().data;
  assert.equal(
    (await clarify(identity, { ...data, task: { ...data.task, revision: next.task.revision } }))
      .statusCode,
    409,
  );
  const records = (await history(peer, data.task.id)).json().data;
  assert.equal(records.clarificationAnswers.length, 1);
  assert.equal(records.clarificationAnswers[0].attemptId, data.currentAttempt.id);
});

test('澄清审计失败回滚答复与排队状态，恢复后原动作键可提交', async () => {
  const identity = await login();
  const { data } = await waitingTask(identity);
  const key = randomUUID();
  await client.query(
    `CREATE FUNCTION clarification_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.clarified' THEN RAISE EXCEPTION 'synthetic clarification failure'; END IF; RETURN NEW; END; $$`,
  );
  await client.query(
    'CREATE TRIGGER clarification_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION clarification_audit_failure()',
  );
  try {
    const before = await fingerprint();
    const failed = await clarify(identity, data, { key });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.ok(!failed.body.includes('synthetic clarification failure'));
    assert.deepEqual(await fingerprint(), before);
  } finally {
    await client.query('DROP TRIGGER clarification_audit_failure ON audit_events');
    await client.query('DROP FUNCTION clarification_audit_failure()');
  }
  assert.equal((await clarify(identity, data, { key })).statusCode, 202);
});
