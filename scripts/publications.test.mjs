import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { createApp } from '../backend/src/app.ts';
import { AuthService } from '../backend/src/auth.ts';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { hashPassword } from '../backend/src/password.ts';
import { TaskService } from '../backend/src/task-service.ts';
import { MockTaskExecutor } from '../backend/src/mock-task-executor.ts';
import { PublicationSender } from '../backend/src/publication-sender.ts';
import { SimulationPublicationAdapter } from '../tests/fixtures/simulation-publication-adapter.mjs';
import { runMigrations } from './migrations.mjs';

// Creates a disposable database. Never migrates or seeds the business database.
const envPath = new URL('../.env', import.meta.url);
const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const explicitAdmin = process.env.PUBLICATION_TEST_ADMIN_URL ?? process.env.TASK_TEST_DATABASE_URL;
const adminUrl = explicitAdmin
  ? new URL(explicitAdmin)
  : new URL(`postgresql://127.0.0.1:${env.POSTGRES_PORT || '5432'}/postgres`);
if (!['localhost', '127.0.0.1'].includes(adminUrl.hostname))
  throw new Error('发布防重测试只接受本机 PostgreSQL 测试实例。');
if (!explicitAdmin) {
  if (!env.POSTGRES_USER || !env.POSTGRES_PASSWORD)
    throw new Error('需要 PUBLICATION_TEST_ADMIN_URL 或本地 PostgreSQL 管理配置。');
  adminUrl.username = env.POSTGRES_USER;
  adminUrl.password = env.POSTGRES_PASSWORD;
}
const suffix = randomBytes(6).toString('hex');
const dbName = `publication_test_${suffix}`,
  roleName = `publication_app_${suffix}`;
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
const origin = 'http://127.0.0.1:5173';
const password = 'synthetic-publication-password';
let client, database, secondDatabase, app, actor, identity, now, storedHash, runtimeUrl;
let dbCreated = false,
  roleCreated = false;
const service = (adapter, db = database) =>
  new TaskService(db.db, () => new Date(now), {
    simulationPublicationAdapter: adapter,
  });

before(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  dbCreated = true;
  const target = new URL(adminUrl);
  target.pathname = '/' + dbName;
  client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 5000 });
  await client.connect();
  await runMigrations(client, 'migrate');
  const rolePassword = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${rolePassword}'`,
  );
  roleCreated = true;
  await client.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`,
  );
  runtimeUrl = new URL(target);
  runtimeUrl.username = roleName;
  runtimeUrl.password = rolePassword;
  database = createBusinessDatabase(runtimeUrl.href);
  secondDatabase = createBusinessDatabase(runtimeUrl.href);
  storedHash = await hashPassword(password);
});
beforeEach(async () => {
  if (app) await app.close();
  await client.query('TRUNCATE teams,tasks,idempotency_records CASCADE');
  now = new Date();
  const teamId = (
    await client.query("INSERT INTO teams(name) VALUES ('synthetic publication team') RETURNING id")
  ).rows[0].id;
  await client.query(
    "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'publication.admin',$2,'合成测试成员','admin')",
    [teamId, storedHash],
  );
  app = createApp({
    logging: false,
    auth: new AuthService(database.db, {
      secret: randomBytes(32),
      trustedOrigins: [origin],
      secureCookie: false,
    }),
    tasks: new TaskService(database.db, () => new Date(now)),
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('No Agent or platform calls permitted');
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login: 'publication.admin', password },
  });
  assert.equal(response.statusCode, 200, response.body);
  actor = response.json().data.member;
  identity = {
    cookie: response.headers['set-cookie'].split(';')[0],
    'x-csrf-token': response.json().data.csrfToken,
  };
});
after(async () => {
  if (app) await app.close();
  if (database) await database.close();
  if (secondDatabase) await secondDatabase.close();
  if (client) await client.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${dbName}"`);
  if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
  await admin.end();
});

async function api(method, url, payload, expected = 200) {
  const response = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: { origin, ...identity, 'idempotency-key': randomUUID() },
  });
  assert.equal(response.statusCode, expected, response.body);
  return response.json().data;
}
async function ready(stoppedAttempt = false) {
  await api('PUT', '/api/v1/account-registration', {
    expectedVersion: 0,
    displayName: '合成账号',
    platformAccountId: '1234567890',
    manualPublishEnabled: true,
    manualAuthorizationConfirmed: true,
    reason: '隔离测试，不真实发布',
  });
  let d = await api(
    'POST',
    '/api/v1/tasks',
    { title: '发布防重测试', originalRequest: '仅用于测试' },
    201,
  );
  const taskId = d.task.id;
  if (stoppedAttempt) {
    d = await api(
      'POST',
      `/api/v1/tasks/${taskId}/attempts`,
      { expectedRevision: d.task.revision },
      202,
    );
    d = await api(
      'POST',
      `/api/v1/tasks/${taskId}/attempts/${d.currentAttempt.id}/stop`,
      { expectedRevision: d.task.revision, reason: '停止生成后人工改稿' },
      202,
    );
  }
  d = (
    await api(
      'POST',
      `/api/v1/tasks/${taskId}/content-versions`,
      {
        expectedRevision: d.task.revision,
        baseContentVersionId: null,
        body: '  介绍产品功能。\n详情以官方说明为准。\n',
      },
      201,
    )
  ).task;
  await api(
    'POST',
    `/api/v1/tasks/${taskId}/reviews`,
    {
      expectedRevision: d.task.revision,
      contentVersionId: d.currentContent.id,
      subjectiveNote: '',
    },
    202,
  );
  d = await api('GET', `/api/v1/tasks/${taskId}`);
  await api(
    'POST',
    `/api/v1/tasks/${taskId}/approvals`,
    {
      expectedRevision: d.task.revision,
      contentVersionId: d.currentContent.id,
      contentHash: d.currentContent.contentHash,
      reviewCycleId: d.currentReview.id,
      accountId: d.account.id,
    },
    201,
  );
  d = await api('GET', `/api/v1/tasks/${taskId}`);
  return {
    taskId,
    actor,
    key: randomUUID(),
    requestId: randomUUID(),
    body: {
      expectedRevision: d.task.revision,
      accountId: d.account.id,
      approvalId: d.currentApproval.id,
      contentVersionId: d.currentContent.id,
      contentHash: d.currentContent.contentHash,
      channel: 'simulation',
    },
  };
}
async function counts() {
  return (
    await client.query(`SELECT (SELECT count(*)::int FROM task_publication_operations) operations,
    (SELECT count(*)::int FROM task_publication_dispatches) dispatches,
    (SELECT count(*)::int FROM task_publication_send_claims) claims`)
  ).rows[0];
}
async function verify(svc, command, conclusion = 'not_published') {
  const d = await svc.get({ taskId: command.taskId, actor });
  return svc.publicationResult({
    taskId: command.taskId,
    operationId: d.currentPublication.id,
    actor,
    kind: 'verification',
    key: randomUUID(),
    requestId: randomUUID(),
    body: {
      expectedRevision: d.task.revision,
      accountId: d.account.id,
      contentVersionId: d.currentContent.id,
      dispatchId: d.currentPublication.currentDispatchId,
      conclusion,
      evidenceIds: [],
      manualConfirmed: conclusion !== 'unknown',
      previousDispatchFenced: conclusion === 'not_published',
      note: conclusion === 'unknown' ? '仍无法确定' : '人工查明尚未发布，已停止原发送。',
    },
  });
}
function retry(command, result) {
  return {
    ...command,
    operationId: result.data.operation.id,
    key: randomUUID(),
    requestId: randomUUID(),
    body: {
      ...command.body,
      expectedRevision: result.data.task.task.revision,
      previousDispatchId: result.data.operation.currentDispatchId,
      reason: '人工核实未发布后重试',
    },
  };
}

test('同版本跨连接并发提交10次，仅一次适配器调用、一个稳定操作和发送；换键/过期/重建均不重发', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  const services = [service(adapter), service(adapter, secondDatabase)];
  const keys = Array.from({ length: 10 }, () => randomUUID());
  const results = await Promise.all(
    keys.map((key, i) => services[i % 2].publish({ ...command, key })),
  );
  assert.equal(new Set(results.map((r) => r.data.operation.id)).size, 1);
  assert.equal(new Set(results.map((r) => r.data.operation.currentDispatchId)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].idempotencyKey, results[0].data.operation.currentDispatchId);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });
  await assert.rejects(
    services[0].publish({
      ...command,
      key: keys[0],
      body: { ...command.body, contentHash: '0'.repeat(64) },
    }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
  await secondDatabase.close();
  secondDatabase = createBusinessDatabase(runtimeUrl.href);
  now = new Date(now.getTime() + 2 * 86400000);
  for (const key of [keys[0], randomUUID()]) {
    const replay = await service(adapter, secondDatabase).publish({ ...command, key });
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.operation.status, 'published');
  }
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });
  const db = await database.db.execute('SELECT current_user');
  assert.equal(db.rows[0].current_user, roleName);
});

for (const scenario of ['timeout', 'response_lost', 'unknown']) {
  test(`${scenario}进入待核实，重复提交和服务恢复不重发；只有人工核实未发布后可并发重试一次`, async () => {
    const command = await ready();
    const adapter = new SimulationPublicationAdapter(scenario, 30);
    const svc = service(adapter);
    const result = await svc.publish(command);
    assert.equal(result.data.operation.status, 'verification_required');
    assert.equal(result.data.task.task.activePublishOperationId, result.data.operation.id);
    assert.equal(result.data.operation.dispatches[0].error.retryable, false);
    await assert.rejects(svc.retryPublication(retry(command, result)), {
      code: 'PUBLICATION_LOCKED',
    });
    await verify(svc, command, 'unknown');
    await service(adapter, secondDatabase).recoverSimulatedPublication({
      taskId: command.taskId,
      operationId: result.data.operation.id,
      actor,
    });
    await service(adapter, secondDatabase).publish({ ...command, key: randomUUID() });
    assert.equal(adapter.calls.length, 1);
    const confirmed = await verify(svc, command);
    assert.equal(confirmed.data.operation.status, 'failed');
    const next = retry(command, confirmed);
    adapter.scenario = 'success';
    const retries = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service(adapter, i % 2 ? database : secondDatabase).retryPublication({
          ...next,
          key: randomUUID(),
        }),
      ),
    );
    assert.equal(retries.filter((r) => !r.replayed).length, 1);
    assert.equal(adapter.calls.length, 2);
    assert.deepEqual(await counts(), { operations: 1, dispatches: 2, claims: 2 });
    assert.equal(new Set(retries.map((r) => r.data.operation.id)).size, 1);
    assert.equal(new Set(retries.map((r) => r.data.operation.currentDispatchId)).size, 1);
    await svc.retryPublication({ ...next, key: randomUUID() });
    assert.equal(adapter.calls.length, 2);
  });
}

test('真实子进程发送后退出，重建服务只恢复为待核实且不重新发送', async () => {
  const command = await ready();
  const child = fork(
    new URL('../tests/fixtures/publication-process-exit.mjs', import.meta.url),
    [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let diagnostics = '';
  child.stderr.on('data', (data) => {
    diagnostics += data;
  });
  const received = [];
  child.on('message', (message) => received.push(message));
  const exit = once(child, 'exit');
  child.send({ command, databaseUrl: runtimeUrl.href });
  const [code] = await exit;
  assert.equal(code, 23, diagnostics);
  assert.equal(received.length, 1);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });
  const adapter = new SimulationPublicationAdapter();
  const svc = service(adapter, secondDatabase);
  const d = await svc.get({ taskId: command.taskId, actor });
  assert.equal(d.publication, 'publishing');
  const claim = (
    await client.query('SELECT * FROM task_publication_send_claims WHERE dispatch_id=$1', [
      d.currentPublication.currentDispatchId,
    ])
  ).rows[0];
  assert.ok(claim.expires_at);
  const reaper = new MockTaskExecutor(database.db, { enabled: false, now: () => new Date(now) });
  // A new process must not classify another sender as interrupted before its deadline.
  assert.equal(await reaper.tick(), false);
  now = new Date(new Date(claim.expires_at).getTime() + 1);
  assert.equal(await reaper.tick(), true);
  assert.equal(await reaper.tick(), false);
  const recovered = await svc.get({ taskId: command.taskId, actor });
  assert.equal(recovered.publication, 'verification_required');
  assert.equal(recovered.currentPublication.dispatches[0].error.code, 'PUBLICATION_INTERRUPTED');
  await svc.publish({ ...command, key: randomUUID() });
  await assert.rejects(
    svc.retryPublication(
      retry(command, { data: { operation: recovered.currentPublication, task: recovered } }),
    ),
    { code: 'PUBLICATION_LOCKED' },
  );
  assert.equal(adapter.calls.length, 0);
});

test('明确失败不自动重发，必须补人工未发布证明；批准失效后仍拒绝重试', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('failure');
  const svc = service(adapter);
  const failed = await svc.publish(command);
  assert.equal(failed.data.operation.status, 'failed');
  await assert.rejects(svc.retryPublication(retry(command, failed)), { code: 'APPROVAL_INVALID' });
  const confirmed = await verify(svc, command);
  await client.query('UPDATE tasks SET current_approval_id=NULL WHERE id=$1', [command.taskId]);
  await assert.rejects(svc.retryPublication(retry(command, confirmed)), {
    code: 'APPROVAL_INVALID',
  });
  assert.equal(adapter.calls.length, 1);
});

test('模拟能力未注入时不可发送，HTTP拒绝simulation；人工交接并发仍只创建一次且不调用适配器', async () => {
  const command = await ready();
  await assert.rejects(new TaskService(database.db).publish(command), { code: 'NOT_IMPLEMENTED' });
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${command.taskId}/publications`,
    headers: { origin, ...identity, 'idempotency-key': randomUUID() },
    payload: command.body,
  });
  assert.equal(response.statusCode, 400);
  const adapter = new SimulationPublicationAdapter();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      service(adapter).publish({
        ...command,
        key: randomUUID(),
        body: { ...command.body, channel: 'manual' },
      }),
    ),
  );
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 0 });
});

test('数据库直接阻止重复业务身份、第二个未决发送和删除或改写发送占用', async () => {
  const command = await ready();
  const svc = service(new SimulationPublicationAdapter('unknown'));
  const {
    data: { operation: op },
  } = await svc.publish(command);
  await assert.rejects(
    client.query('DELETE FROM task_publication_send_claims WHERE dispatch_id=$1', [
      op.currentDispatchId,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    client.query('UPDATE task_publication_send_claims SET created_at=now() WHERE dispatch_id=$1', [
      op.currentDispatchId,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    client.query(
      `INSERT INTO task_publication_operations SELECT gen_random_uuid(), task_id,content_version_id,content_hash,account_id,approval_id,config_version,snapshot,status,current_dispatch_id,created_by,created_at,updated_at FROM task_publication_operations WHERE id=$1`,
      [op.id],
    ),
    { code: '23505' },
  );
  await assert.rejects(
    client.query(
      `INSERT INTO task_publication_dispatches(id,operation_id,dispatch_no,previous_dispatch_id,reason,approval_id,channel,status,started_by,started_at) VALUES (gen_random_uuid(),$1,2,$2,'duplicate',$3,'simulation','publishing',$4,now())`,
      [op.id, op.currentDispatchId, command.body.approvalId, actor.id],
    ),
    { code: '23505' },
  );
});

test('发送占用审计失败回滚且不调用适配器，之后重放原请求也不擅自发送', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  await client.query(
    `CREATE FUNCTION fail_send_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.send_claimed' THEN RAISE EXCEPTION 'synthetic outage'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER fail_send_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_send_audit()',
  );
  try {
    await assert.rejects(service(adapter).publish(command), { code: 'DEPENDENCY_UNAVAILABLE' });
    assert.equal(adapter.calls.length, 0);
    assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 0 });
  } finally {
    await client.query('DROP TRIGGER fail_send_audit ON audit_events');
    await client.query('DROP FUNCTION fail_send_audit()');
  }
  const replayed = await service(adapter).publish(command);
  assert.equal(replayed.replayed, true);
  await service(adapter).recoverSimulatedPublication({
    taskId: command.taskId,
    operationId: replayed.data.operation.id,
    actor,
  });
  assert.equal(adapter.calls.length, 0);
});

test('发送占用在多连接下只允许一个调用者进入适配器', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('unknown');
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  adapter.send = async (input) => {
    adapter.calls.push(input);
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const svc = service(adapter);
  const sending = svc.publish(command);
  await started;
  const detail = await svc.get({ taskId: command.taskId, actor });
  const competing = new PublicationSender(
    secondDatabase.db,
    (_tx, id, who) => svc.get({ taskId: id, actor: who }),
    () => new Date(now),
    adapter,
  );
  await Promise.all(
    Array.from({ length: 10 }, () =>
      competing.send({
        taskId: command.taskId,
        operationId: detail.currentPublication.id,
        dispatchId: detail.currentPublication.currentDispatchId,
        actor,
      }),
    ),
  );
  assert.equal(adapter.calls.length, 1);
  release({ outcome: 'unknown' });
  await sending;
});

test('发送后结果事务失败，保留占用并恢复待核实，不能因没有成功回执而重发', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  await client.query(
    `CREATE FUNCTION fail_send_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.simulation_published' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER fail_send_result BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_send_result()',
  );
  try {
    await assert.rejects(service(adapter).publish(command), { code: 'DEPENDENCY_UNAVAILABLE' });
    assert.equal(adapter.calls.length, 1);
    assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });
  } finally {
    await client.query('DROP TRIGGER fail_send_result ON audit_events');
    await client.query('DROP FUNCTION fail_send_result()');
  }
  const replay = await service(adapter, secondDatabase).publish({ ...command, key: randomUUID() });
  assert.equal(replay.replayed, true);
  const recovered = await service(adapter, secondDatabase).recoverSimulatedPublication({
    taskId: command.taskId,
    operationId: replay.data.operation.id,
    actor,
  });
  assert.equal(recovered.publication, 'verification_required');
  assert.equal(adapter.calls.length, 1);
});

test('跨成员重复提交共享同一个操作；发送前批准或取消检查失败时不能调用适配器', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('unknown');
  const svc = service(adapter);
  const result = await svc.publish(command);
  const peer = (
    await client.query(
      `INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'publication.peer',$2,'合成运营成员','operator') RETURNING id`,
      [actor.teamId, storedHash],
    )
  ).rows[0];
  await service(adapter, secondDatabase).publish({
    ...command,
    key: randomUUID(),
    actor: { ...actor, id: peer.id, role: 'operator' },
  });
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });

  const confirmed = await verify(svc, command);
  // Reserve a retry without reaching I/O, as if the handler died before claiming.
  await client.query(
    `CREATE FUNCTION fail_preflight_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.send_claimed' THEN RAISE EXCEPTION 'synthetic outage'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER fail_preflight_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_preflight_audit()',
  );
  try {
    await assert.rejects(svc.retryPublication(retry(command, confirmed)), {
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  } finally {
    await client.query('DROP TRIGGER fail_preflight_audit ON audit_events');
    await client.query('DROP FUNCTION fail_preflight_audit()');
  }
  const d = await svc.get({ taskId: command.taskId, actor });
  const sender = new PublicationSender(
    database.db,
    (_tx, id, who) => svc.get({ taskId: id, actor: who }),
    () => new Date(now),
    adapter,
  );
  const send = () =>
    sender.send({
      taskId: command.taskId,
      operationId: result.data.operation.id,
      dispatchId: d.currentPublication.currentDispatchId,
      actor,
    });
  await client.query('UPDATE tasks SET current_approval_id=NULL WHERE id=$1', [command.taskId]);
  await send();
  const blocked = await svc.get({ taskId: command.taskId, actor });
  assert.equal(blocked.currentPublication.status, 'failed');
  assert.equal(blocked.task.activePublishOperationId, null);
  assert.equal(
    blocked.currentPublication.dispatches.at(-1).error.code,
    'PUBLICATION_APPROVAL_INVALID',
  );
  await send();
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 2, claims: 1 });
});

async function reserveUnsent(svc, command) {
  await client.query(
    `CREATE FUNCTION hold_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.send_claimed' THEN RAISE EXCEPTION 'synthetic pre-send pause'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER hold_admission BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION hold_admission()',
  );
  try {
    await assert.rejects(svc.publish(command), { code: 'DEPENDENCY_UNAVAILABLE' });
  } finally {
    await client.query('DROP TRIGGER hold_admission ON audit_events');
    await client.query('DROP FUNCTION hold_admission()');
  }
  return svc.get({ taskId: command.taskId, actor });
}
const senderFor = (svc, adapter, db = database) =>
  new PublicationSender(
    db.db,
    (_tx, id, who) => svc.get({ taskId: id, actor: who }),
    () => new Date(now),
    adapter,
  );
const identityFor = (d) => ({
  taskId: d.task.id,
  operationId: d.currentPublication.id,
  dispatchId: d.currentPublication.currentDispatchId,
  actor,
});
const termination = (d) => ({
  taskId: d.task.id,
  actor,
  body: { expectedRevision: d.task.revision, reason: '用户取消本次运营任务' },
  key: randomUUID(),
  requestId: randomUUID(),
});

for (const scenario of ['version', 'approval', 'configuration', 'cancellation_intent']) {
  test(`发送前重新检查${scenario}，确定未发送则持久化失败并解锁，旧请求不得复活`, async () => {
    const command = await ready(scenario === 'cancellation_intent');
    const adapter = new SimulationPublicationAdapter();
    const svc = service(adapter);
    const d = await reserveUnsent(svc, command);
    if (scenario === 'version') {
      const newer = (
        await client.query(
          `INSERT INTO task_contents(task_id,version_no,parent_version_id,body,content_hash,source_kind,created_by) SELECT task_id,version_no+1,id,$2,encode(sha256(convert_to($2,'UTF8')),'hex'),'manual',created_by FROM task_contents WHERE id=$1 RETURNING id`,
          [command.body.contentVersionId, '已替换为新的文案版本。'],
        )
      ).rows[0].id;
      await client.query('UPDATE tasks SET current_content_version_id=$1 WHERE id=$2', [
        newer,
        command.taskId,
      ]);
    } else if (scenario === 'approval') {
      await client.query('UPDATE tasks SET current_approval_id=NULL WHERE id=$1', [command.taskId]);
    } else if (scenario === 'configuration') {
      await client.query(
        `INSERT INTO config_versions(account_id,version,profile,tone,forbidden_topics,rules,model_ref,prompt_version,tool_version,max_auto_revisions,change_reason,updated_by) SELECT account_id,version+1,profile,tone,forbidden_topics,rules,model_ref,prompt_version,tool_version,max_auto_revisions,'changed config',updated_by FROM config_versions WHERE account_id=$1 AND version=(SELECT current_config_version FROM accounts WHERE id=$1)`,
        [command.body.accountId],
      );
      await client.query(
        'UPDATE accounts SET current_config_version=current_config_version+1 WHERE id=$1',
        [command.body.accountId],
      );
    } else {
      await client.query(
        "UPDATE execution_attempts SET cancel_scope='terminate_task' WHERE task_id=$1",
        [command.taskId],
      );
    }
    await senderFor(svc, adapter).send(identityFor(d));
    const latest = await svc.get({ taskId: command.taskId, actor });
    assert.equal(latest.task.activePublishOperationId, null);
    const record = await svc.getPublication({
      taskId: command.taskId,
      operationId: d.currentPublication.id,
      actor,
    });
    assert.equal(record.operation.status, 'failed');
    const failure = record.operation.dispatches[0].error;
    assert.equal(
      failure.code,
      scenario === 'version'
        ? 'PUBLICATION_VERSION_CHANGED'
        : scenario === 'cancellation_intent'
          ? 'PUBLICATION_CANCELLED'
          : 'PUBLICATION_APPROVAL_INVALID',
    );
    assert.match(failure.message, /^未发送：/);
    assert.equal(failure.retryable, false);
    assert.equal(adapter.calls.length, 0);
    await svc.publish({ ...command, key: randomUUID() });
    await senderFor(svc, adapter).send(identityFor(d));
    assert.equal(adapter.calls.length, 0);
    assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 0 });
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='publication.preflight_rejected'",
        )
      ).rows[0].n,
      1,
    );
  });
}

test('停止一次执行不等于终止任务；人工新版本批准后仍可发送', async () => {
  const command = await ready(true);
  const adapter = new SimulationPublicationAdapter();
  assert.equal((await service(adapter).publish(command)).data.operation.status, 'published');
  assert.equal(adapter.calls.length, 1);
});

test('终止接口原子失效批准并记录操作者/时间/原因，10次并发与过期键重放只终止一次', async () => {
  const command = await ready();
  const svc = service(new SimulationPublicationAdapter());
  const d = await svc.get({ taskId: command.taskId, actor });
  const request = termination(d);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      service(new SimulationPublicationAdapter(), i % 2 ? database : secondDatabase).terminate({
        ...request,
        key: i === 0 ? request.key : randomUUID(),
      }),
    ),
  );
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  const result = results[0].data;
  assert.equal(result.task.lifecycle, 'terminated');
  assert.equal(result.task.terminatedBy, actor.id);
  assert.equal(result.task.terminatedAt, now.toISOString());
  assert.equal(result.task.terminationReason, request.body.reason);
  assert.equal(result.currentApproval.status, 'invalidated');
  for (const action of ['save', 'start', 'retry', 'review', 'approve', 'publish', 'terminate'])
    assert.equal(result.actions[action].allowed, false, action);
  await assert.rejects(svc.publish(command));
  await assert.rejects(
    svc.terminate({ ...request, body: { ...request.body, reason: '不同原因' } }),
    { code: 'IDEMPOTENCY_KEY_REUSED' },
  );
  now = new Date(now.getTime() + 2 * 86400000);
  const replay = await service(new SimulationPublicationAdapter(), secondDatabase).terminate(
    request,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.task.terminationReason, request.body.reason);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='task.terminated'",
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await counts(), { operations: 0, dispatches: 0, claims: 0 });
});

for (const phase of ['queued', 'running', 'awaiting_clarification']) {
  test(`终止${phase}模拟执行后持久化停止与代次隔离，执行器不会继续产出`, async () => {
    let d = await api(
      'POST',
      '/api/v1/tasks',
      { title: '取消执行测试', originalRequest: '模拟任务' },
      201,
    );
    const svc = service(new SimulationPublicationAdapter());
    const worker = new MockTaskExecutor(database.db, { now: () => new Date(now) });
    d = (
      await svc.start({
        taskId: d.task.id,
        actor,
        body: {
          expectedRevision: d.task.revision,
          simulationScenario: phase === 'awaiting_clarification' ? 'clarification' : 'success',
        },
        key: randomUUID(),
        requestId: randomUUID(),
      })
    ).data;
    for (let i = 0; i < 8 && d.execution !== phase; i++) {
      now = new Date(now.getTime() + 10000);
      await worker.tick();
      d = await svc.get({ taskId: d.task.id, actor });
    }
    assert.equal(d.execution, phase);
    const result = await svc.terminate(termination(d));
    assert.equal(result.data.task.lifecycle, 'terminated');
    assert.equal(result.data.execution, 'cancelled');
    assert.equal(result.data.currentAttempt.cancelScope, 'terminate_task');
    assert.equal(result.data.currentAttempt.cancelRequestedBy, actor.id);
    assert.equal(result.data.currentAttempt.stoppedAt, now.toISOString());
    assert.equal(result.data.workLock, null);
    now = new Date(now.getTime() + 10000);
    assert.equal(await worker.tick(), false);
    const history = await svc.history({ taskId: d.task.id, actor, query: {} });
    assert.ok(history.steps.every((step) => !['queued', 'running'].includes(step.status)));
    assert.equal(
      (
        await client.query('SELECT count(*)::int AS n FROM task_contents WHERE task_id=$1', [
          d.task.id,
        ])
      ).rows[0].n,
      0,
    );
  });
}

for (const scope of ['stop_attempt', 'terminate_task']) {
  for (const phase of ['queued', 'research', 'content']) {
    test(`D9 ${scope} 在 ${phase} 安全点生效，迟到结果不能产出或新增发布`, async () => {
      const adapter = new SimulationPublicationAdapter();
      const svc = service(adapter);
      let d = await api(
        'POST',
        '/api/v1/tasks',
        { title: 'D9 取消矩阵', originalRequest: '仅用于隔离验收' },
        201,
      );
      const id = d.task.id;
      d = (
        await svc.start({
          taskId: id,
          actor,
          body: { expectedRevision: d.task.revision },
          key: randomUUID(),
          requestId: randomUUID(),
        })
      ).data;
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const roles = [];
      const worker = new MockTaskExecutor(database.db, {
        now: () => new Date(now),
        runStep: async ({ role }) => {
          roles.push(role);
          if (role === phase) {
            entered();
            await held; // Deliberately ignore cancellation and return late.
          }
          return { usage: { tokens: 0, estimatedCostMicrosCny: 0 } };
        },
      });
      let pending;
      try {
        if (phase !== 'queued') {
          for (let index = 0; index < 5; index++) {
            now = new Date(now.getTime() + 1000);
            await worker.tick();
            const step = (
              await client.query(
                "SELECT role FROM execution_steps WHERE attempt_id=$1 AND status='running'",
                [d.currentAttempt.id],
              )
            ).rows[0];
            if (step?.role === phase) break;
          }
          now = new Date(now.getTime() + 1000);
          pending = worker.tick();
          await started;
        }
        d = await svc.get({ taskId: id, actor });
        const command = {
          taskId: id,
          actor,
          body: { expectedRevision: d.task.revision, reason: `在 ${phase} 取消` },
          key: randomUUID(),
          requestId: randomUUID(),
        };
        const stopped =
          scope === 'terminate_task'
            ? await svc.terminate(command)
            : await svc.stop({ ...command, attemptId: d.currentAttempt.id });
        assert.equal(stopped.data.execution, 'cancelled');
        assert.equal(stopped.data.currentAttempt.cancelScope, scope);
        assert.equal(
          stopped.data.task.lifecycle,
          scope === 'terminate_task' ? 'terminated' : 'open',
        );
        const roleCount = roles.length;
        const before = await svc.history({ taskId: id, actor, query: {} });
        release();
        if (pending) await pending;
        now = new Date(now.getTime() + 1000);
        for (let i = 0; i < 3; i++) assert.equal(await worker.tick(), false);
        const after = await svc.history({ taskId: id, actor, query: {} });
        assert.deepEqual(after.attempts, before.attempts);
        assert.deepEqual(after.calls, before.calls);
        assert.deepEqual(after.steps, before.steps);
        assert.ok(after.steps.every((step) => !['queued', 'running'].includes(step.status)));
        assert.equal(roles.length, roleCount);
        assert.equal(adapter.calls.length, 0);
        assert.deepEqual(await counts(), { operations: 0, dispatches: 0, claims: 0 });
        assert.equal(
          (
            await client.query('SELECT count(*)::int AS n FROM task_contents WHERE task_id=$1', [
              id,
            ])
          ).rows[0].n,
          0,
        );
      } finally {
        release();
        if (pending) await pending;
      }
    });
  }
}

test('取消先于发送占用提交时，原发布结束并解锁；发送后再终止被拒绝且不会误解锁', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  const svc = service(adapter);
  const d = await reserveUnsent(svc, command);
  assert.equal(d.actions.terminate.allowed, true);
  const cancelled = await svc.terminate(termination(d));
  assert.equal(cancelled.data.task.lifecycle, 'terminated');
  assert.equal(cancelled.data.currentPublication.status, 'failed');
  assert.equal(cancelled.data.currentPublication.dispatches[0].error.code, 'PUBLICATION_CANCELLED');
  await senderFor(svc, adapter).send(identityFor(d));
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 0 });
});

test('发送占用已提交后，即使批准失效也不得清除占用或解锁；拒绝终止并保留待核实', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('unknown', 10000);
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  adapter.send = async (input) => {
    adapter.calls.push(input);
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const svc = service(adapter);
  const sending = svc.publish(command);
  await started;
  try {
    const d = await svc.get({ taskId: command.taskId, actor });
    assert.equal(d.actions.terminate.allowed, false);
    await assert.rejects(service(adapter, secondDatabase).terminate(termination(d)), {
      code: 'PUBLICATION_LOCKED',
    });
    await client.query('UPDATE tasks SET current_approval_id=NULL WHERE id=$1', [command.taskId]);
    await senderFor(svc, adapter, secondDatabase).send(identityFor(d));
    assert.equal((await svc.get({ taskId: command.taskId, actor })).publication, 'publishing');
    assert.equal(adapter.calls.length, 1);
  } finally {
    release({ outcome: 'unknown' });
    await sending;
  }
  const pending = await svc.get({ taskId: command.taskId, actor });
  assert.equal(pending.publication, 'verification_required');
  assert.ok(pending.task.activePublishOperationId);
  assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 1 });
});

test('终止与取得发送占用并发时，只有一个胜出；不会取消成功后仍发送', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('unknown');
  const svc = service(adapter);
  const d = await reserveUnsent(svc, command);
  const results = await Promise.allSettled([
    senderFor(svc, adapter).send(identityFor(d)),
    service(adapter, secondDatabase).terminate(termination(d)),
  ]);
  const latest = await svc.get({ taskId: command.taskId, actor });
  if (results[1].status === 'fulfilled') {
    assert.equal(latest.task.lifecycle, 'terminated');
    assert.equal(adapter.calls.length, 0);
    assert.deepEqual(await counts(), { operations: 1, dispatches: 1, claims: 0 });
  } else {
    assert.ok(['PUBLICATION_LOCKED', 'REVISION_CONFLICT'].includes(results[1].reason.code));
    assert.equal(latest.task.lifecycle, 'open');
    assert.equal(adapter.calls.length, 1);
    assert.equal(latest.publication, 'verification_required');
    assert.ok(latest.task.activePublishOperationId);
  }
});

test('终止接口校验身份、团队、版本和原因，人工交接锁定后不能直接取消', async () => {
  const command = await ready();
  const svc = service(new SimulationPublicationAdapter());
  const d = await svc.get({ taskId: command.taskId, actor });
  const request = termination(d);
  const path = `/api/v1/tasks/${command.taskId}/terminate`;
  await assert.rejects(svc.terminate({ ...request, body: { ...request.body, reason: '   ' } }), {
    code: 'VALIDATION_ERROR',
  });
  await assert.rejects(
    svc.terminate({ ...request, body: { ...request.body, expectedRevision: d.task.revision - 1 } }),
    { code: 'REVISION_CONFLICT' },
  );
  await assert.rejects(
    svc.terminate({ ...request, actor: { ...actor, version: actor.version + 1 } }),
    { code: 'FORBIDDEN' },
  );
  const otherTeam = (await client.query("INSERT INTO teams(name) VALUES ('other') RETURNING id"))
    .rows[0].id;
  const other = (
    await client.query(
      "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'other',$2,'other','operator') RETURNING id",
      [otherTeam, storedHash],
    )
  ).rows[0].id;
  await assert.rejects(
    svc.terminate({
      ...request,
      actor: { ...actor, teamId: otherTeam, id: other, role: 'operator' },
    }),
    { code: 'NOT_FOUND' },
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: path, payload: request.body })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: path,
        payload: request.body,
        headers: {
          ...identity,
          origin: 'https://invalid.example',
          'idempotency-key': randomUUID(),
        },
      })
    ).statusCode,
    403,
  );
  const manual = await svc.publish({ ...command, body: { ...command.body, channel: 'manual' } });
  await assert.rejects(svc.terminate(termination(manual.data.task)), {
    code: 'PUBLICATION_LOCKED',
  });
  assert.equal((await svc.get({ taskId: command.taskId, actor })).task.lifecycle, 'open');
});

test('终止审计失败时任务、批准、发布失败和解锁全部回滚，恢复后原键可以确认', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  const svc = service(adapter);
  const d = await reserveUnsent(svc, command);
  const request = termination(d);
  await client.query(
    `CREATE FUNCTION fail_termination() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.terminated' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    'CREATE TRIGGER fail_termination BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_termination()',
  );
  try {
    await assert.rejects(svc.terminate(request), { code: 'DEPENDENCY_UNAVAILABLE' });
    const still = await svc.get({ taskId: command.taskId, actor });
    assert.equal(still.task.lifecycle, 'open');
    assert.equal(still.currentApproval.status, 'approved');
    assert.equal(still.currentPublication.status, 'publishing');
    assert.ok(still.task.activePublishOperationId);
    assert.equal(still.task.terminatedAt, null);
  } finally {
    await client.query('DROP TRIGGER fail_termination ON audit_events');
    await client.query('DROP FUNCTION fail_termination()');
  }
  const result = await svc.terminate(request);
  assert.equal(result.data.task.lifecycle, 'terminated');
  assert.equal(result.data.currentPublication.status, 'failed');
  assert.equal(adapter.calls.length, 0);
});

test('后台收敛未取得发送占用的超时操作，确认未发送并拒绝旧发送入口', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  const svc = service(adapter);
  const reserved = await reserveUnsent(svc, command);
  const reaper = new MockTaskExecutor(database.db, { enabled: false, now: () => new Date(now) });
  assert.equal(await reaper.tick(), false);
  now = new Date(now.getTime() + 31000);
  assert.equal(await reaper.tick(), true);
  const d = await svc.get({ taskId: command.taskId, actor });
  assert.equal(d.publication, 'failed');
  assert.equal(d.task.activePublishOperationId, null);
  assert.equal(d.currentPublication.dispatches[0].error.code, 'PUBLICATION_NOT_SENT');
  await senderFor(svc, adapter).send(identityFor(reserved));
  assert.equal(adapter.calls.length, 0);
  assert.equal(await reaper.tick(), false);
});

test('旧发送占用没有期限时保留历史，经过保守等待后转待核实且不解锁', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter();
  const svc = service(adapter);
  const reserved = await reserveUnsent(svc, command);
  await client.query(
    'INSERT INTO task_publication_send_claims(operation_id,dispatch_id,created_at) VALUES ($1,$2,$3)',
    [reserved.currentPublication.id, reserved.currentPublication.currentDispatchId, now],
  );
  const reaper = new MockTaskExecutor(database.db, { enabled: false, now: () => new Date(now) });
  now = new Date(now.getTime() + 329000);
  assert.equal(await reaper.tick(), false);
  now = new Date(now.getTime() + 2000);
  assert.equal(await reaper.tick(), true);
  const d = await svc.get({ taskId: command.taskId, actor });
  assert.equal(d.publication, 'verification_required');
  assert.equal(d.task.activePublishOperationId, reserved.currentPublication.id);
  assert.equal(
    (await client.query('SELECT expires_at FROM task_publication_send_claims')).rows[0].expires_at,
    null,
  );
  assert.equal(adapter.calls.length, 0);
});

test('后台中断扫描与发送占用并发时，可能已发送的操作不得按未发送解锁', async () => {
  const command = await ready();
  const adapter = new SimulationPublicationAdapter('unknown');
  const svc = service(adapter);
  const reserved = await reserveUnsent(svc, command);
  now = new Date(now.getTime() + 31000);
  const reaper = new MockTaskExecutor(secondDatabase.db, {
    enabled: false,
    now: () => new Date(now),
  });
  await Promise.all([senderFor(svc, adapter).send(identityFor(reserved)), reaper.tick()]);
  const d = await svc.get({ taskId: command.taskId, actor });
  if (adapter.calls.length) {
    assert.equal(d.publication, 'verification_required');
    assert.equal(d.task.activePublishOperationId, reserved.currentPublication.id);
  } else {
    assert.equal(d.publication, 'failed');
    assert.equal(d.task.activePublishOperationId, null);
    assert.equal(d.currentPublication.dispatches[0].error.code, 'PUBLICATION_NOT_SENT');
  }
});
