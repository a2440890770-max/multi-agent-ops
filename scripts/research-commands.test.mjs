import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../backend/src/app.ts';
import { AuthService } from '../backend/src/auth.ts';
import { hashPassword } from '../backend/src/password.ts';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { TaskService } from '../backend/src/task-service.ts';
import { readAgentExecutionLimits } from '../backend/src/agent-execution-config.ts';
import { runMigrations } from './migrations.mjs';
import { ResearchAuthorizationScopeSchema } from '../shared/src/index.ts';
import { loadGithubProjectResearchSkill } from '../agent/src/agents/research/skills.ts';

// Explicit local disposable instance only. Never load business environment or contact providers.
const rawAdmin = process.env.RESEARCH_TEST_ADMIN_URL;
if (!rawAdmin || !['127.0.0.1', 'localhost'].includes(new URL(rawAdmin).hostname))
  throw new Error('需要显式 RESEARCH_TEST_ADMIN_URL，指向本机隔离测试 PostgreSQL。');
const adminUrl = new URL(rawAdmin),
  suffix = randomBytes(6).toString('hex');
const databaseName = `research_test_${suffix}`,
  roleName = `research_app_${suffix}`;
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
const origin = 'http://127.0.0.1:5173';
const configuration = {
  version: 1,
  supervisor: {
    timeoutMs: 900000,
    maxTurns: 32,
    maxBudgetUsd: 0.1,
    maxOutputTokens: 4096,
    maxOutputAttempts: 3,
  },
  maxSessionTokens: 100000,
  pricing: {
    version: 'offline-fixed-v1',
    inputMicrosCnyPerMillion: 1000000,
    outputMicrosCnyPerMillion: 2000000,
  },
};
const skill = loadGithubProjectResearchSkill();
const policy = {
  promptVersion: 'research-d9-v2',
  toolPolicyVersion: 'research-web-d9-v1',
  configVersion: 1,
  skills: [{ ...skill.metadata, contentSha256: sha(skill.instructions) }],
  limits: {
    timeoutMs: 900000,
    maxSearchCalls: 12,
    maxFetchCalls: 10,
    maxVideoCalls: 0,
    maxOutputAttempts: 3,
    maxBudgetUsd: 0.1,
  },
};
let client,
  database,
  app,
  identity,
  actorId,
  teamId,
  dbCreated = false,
  roleCreated = false;
const authConfig = { secret: randomBytes(32), trustedOrigins: [origin], secureCookie: false };
const fixture = JSON.parse(
  await readFile(new URL('../shared/tests/fixtures/research.json', import.meta.url), 'utf8'),
);
function sha(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function application(enabled = true) {
  return createApp({
    logging: false,
    auth: new AuthService(database.db, authConfig, { accountAttempts: 100, ipAttempts: 100 }),
    tasks: new TaskService(database.db, () => new Date(), {
      executorMode: 'agent',
      agentConfiguration: configuration,
      ...(enabled ? { researchPolicy: policy } : {}),
    }),
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('Research commands must never invoke external services');
    },
  });
}
before(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  dbCreated = true;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 5000 });
  await client.connect();
  await runMigrations(client, 'migrate');
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${roleName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
  );
  roleCreated = true;
  await client.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await client.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`,
  );
  target.username = roleName;
  target.password = password;
  database = createBusinessDatabase(target.href);
});
beforeEach(async () => {
  if (app) await app.close();
  await client.query('TRUNCATE teams,tasks,idempotency_records CASCADE');
  teamId = (
    await client.query("INSERT INTO teams(name) VALUES ('offline research commands') RETURNING id")
  ).rows[0].id;
  actorId = (
    await client.query(
      "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'research.admin',$2,'离线验收','admin') RETURNING id",
      [teamId, await hashPassword('offline-research-password')],
    )
  ).rows[0].id;
  app = application();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login: 'research.admin', password: 'offline-research-password' },
  });
  assert.equal(response.statusCode, 200, response.body);
  identity = {
    cookie: response.headers['set-cookie'].split(';')[0],
    'x-csrf-token': response.json().data.csrfToken,
  };
});
after(async () => {
  if (app) await app.close();
  if (database) await database.close();
  if (client) await client.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
  await admin.end();
});

function post(taskId, path, body, { key = randomUUID(), target = app, headers = {} } = {}) {
  return target.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/${path}`,
    headers: { origin, 'idempotency-key': key, ...identity, ...headers },
    payload: body,
  });
}
async function prepared() {
  const taskId = randomUUID(),
    attemptId = randomUUID(),
    hotId = randomUUID();
  await client.query(
    'INSERT INTO tasks(id,title,original_request,team_id,created_by) VALUES ($1,$2,$3,$4,$5)',
    [taskId, '研究固定项目', '原始要求\r\n不能编造', teamId, actorId],
  );
  const snapshot = {
    executorVersion: 1,
    mode: 'agent',
    configuration: {
      runtime: configuration,
      accountContext: {
        accountId: null,
        description: null,
        defaultAudience: null,
        defaultTone: null,
        prohibitions: [],
      },
    },
  };
  await client.query(
    "INSERT INTO execution_attempts(id,task_id,attempt_no,generation,status,executor_mode,simulation_scenario,config_snapshot,execution_limits,requested_by) VALUES ($1,$2,1,1,'awaiting_selection','agent',null,$3,$4,$5)",
    [attemptId, taskId, snapshot, readAgentExecutionLimits({}), actorId],
  );
  await client.query(
    "UPDATE tasks SET current_attempt_id=$2,work_generation=1,execution_status='awaiting_selection' WHERE id=$1",
    [taskId, attemptId],
  );
  await client.query('INSERT INTO task_execution_budgets(task_id,limits) VALUES ($1,$2)', [
    taskId,
    readAgentExecutionLimits({}),
  ]);
  const list = {
    id: hotId,
    provider: 'xxapi',
    fetchedAt: new Date().toISOString(),
    rankingDescription: null,
    items: [
      {
        id: 'candidate-1',
        title: 'owner/project',
        description: '固定离线候选',
        repositoryUrl: 'https://github.com/owner/project',
      },
      {
        id: 'candidate-2',
        title: 'owner/other',
        description: '第二候选',
        repositoryUrl: 'https://github.com/owner/other',
      },
    ],
  };
  await client.query(
    "INSERT INTO github_hot_snapshots(id,task_id,attempt_id,provider,snapshot,fetched_at) VALUES ($1,$2,$3,'xxapi',$4,$5)",
    [
      hotId,
      taskId,
      attemptId,
      { list, rawResponse: { offline: true }, parserVersion: 'offline-v1' },
      list.fetchedAt,
    ],
  );
  return {
    taskId,
    attemptId,
    hotId,
    selectBody: {
      expectedRevision: 1,
      attemptId,
      hotListSnapshotId: hotId,
      candidateId: 'candidate-1',
      authorizeResearch: true,
    },
  };
}
async function selected() {
  const p = await prepared();
  const response = await post(p.taskId, 'project-selection', p.selectBody);
  assert.equal(response.statusCode, 202, response.body);
  return { ...p, selected: response.json().data };
}
async function priorReport() {
  const p = await selected(),
    researchStepId = randomUUID(),
    inputSnapshotId = randomUUID();
  const execution = {
    taskId: p.taskId,
    attemptId: p.attemptId,
    stepId: researchStepId,
    inputSnapshotId,
  };
  const context = {
    ...structuredClone(fixture.context),
    execution,
    selectedProject: p.selected.selection,
    authorization: { id: p.selected.authorization.id, mode: 'initial' },
  };
  const result = {
    ...structuredClone(fixture.result),
    id: randomUUID(),
    execution,
    selectedProject: p.selected.selection,
    authorizationId: p.selected.authorization.id,
  };
  result.report.status = 'partial';
  result.report.questions[0].status = 'partial';
  result.report.questions[0].gapIds = ['gap-1'];
  result.report.gaps = [
    {
      id: 'gap-1',
      questionIds: ['q-1'],
      sectionIds: [],
      severity: 'core',
      claim: '待核实',
      impact: '需要补查',
      requestedMaterial: '补充一手证据',
    },
  ];
  const source = {
    id: 'user-source-1',
    label: '历史用户资料',
    url: null,
    nature: 'user_provided',
    author: null,
    publishedAt: null,
  };
  const material = {
    id: 'user-material-1',
    sourceId: source.id,
    version: 1,
    kind: 'pasted_text',
    content: '用户原始资料\r\n保留',
    assetIds: [],
    segments: [],
    framePositions: [],
    capturedAt: new Date().toISOString(),
    truncated: false,
    coverage: null,
    firstHandConfirmation: null,
  };
  result.sources.push(source);
  result.materials.push(material);
  await client.query('BEGIN');
  try {
    await client.query(
      "UPDATE execution_attempts SET status='running',executor_id=$2,claim_token=$3,claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '10 minutes',active_since=clock_timestamp() WHERE id=$1",
      [p.attemptId, randomUUID(), randomUUID()],
    );
    await client.query("UPDATE tasks SET execution_status='running' WHERE id=$1", [p.taskId]);
    await client.query(
      "INSERT INTO execution_steps(id,attempt_id,ordinal,role,status,authorization_id,input_snapshot_id,frozen_input,started_at) VALUES ($1,$2,1,'research','running',$3,$4,$5,clock_timestamp())",
      [researchStepId, p.attemptId, p.selected.authorization.id, inputSnapshotId, context],
    );
    await client.query(
      'UPDATE research_authorizations SET consumed_at=clock_timestamp(),consumed_by_step_id=$2 WHERE id=$1',
      [p.selected.authorization.id, researchStepId],
    );
    const registry = {
      schemaVersion: '1.0',
      execution,
      authorizationId: p.selected.authorization.id,
      selectedProject: p.selected.selection,
      policy: {
        version: 'research-web-d9-v1',
        config: {
          root: 'offline',
          maxSearchCalls: 12,
          maxFetchCalls: 10,
          maxSearchResults: 10,
          timeoutMs: 60000,
          maxResponseBytes: 10485760,
          maxTextCharacters: 50000,
          maxRedirects: 5,
        },
        officialSites: [],
      },
      sources: result.sources.map((source) => ({
        source,
        discoveredBy: 'input',
        parentSourceId: null,
        toolUseId: null,
      })),
      materials: result.materials.map((material) => ({
        material,
        method: 'provided',
        contentSha256: sha(material.content),
        responseSha256: null,
        finalUrl: null,
        redirects: [],
        toolUseId: null,
        extractionVersion: 'offline-v1',
        textOffset: null,
      })),
      calls: [],
    };
    await client.query(
      'INSERT INTO research_registries(task_id,attempt_id,authorization_id,step_id,input_snapshot_id,snapshot) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        p.taskId,
        p.attemptId,
        p.selected.authorization.id,
        researchStepId,
        inputSnapshotId,
        registry,
      ],
    );
    await client.query(
      "UPDATE execution_steps SET status='completed',validated_output=$2,result_id=$3,result_version=1,finished_at=clock_timestamp() WHERE id=$1",
      [researchStepId, result, result.id],
    );
    await client.query(
      "UPDATE execution_steps SET status='completed',finished_at=clock_timestamp() WHERE attempt_id=$1 AND role='supervisor'",
      [p.attemptId],
    );
    await client.query(
      "UPDATE execution_attempts SET status='awaiting_materials',executor_id=null,claim_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null,active_since=null,next_run_at=null WHERE id=$1",
      [p.attemptId],
    );
    await client.query(
      "UPDATE tasks SET execution_status='awaiting_materials',revision=revision+1 WHERE id=$1",
      [p.taskId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return {
    ...p,
    result,
    material,
    supplementBody: {
      expectedRevision: 3,
      attemptId: p.attemptId,
      baseResultId: result.id,
      questionIds: ['q-1'],
      gapIds: ['gap-1'],
      materials: [],
      confirmExistingMaterials: [],
      officialSiteGrants: [],
      authorizeResearch: true,
    },
  };
}
async function stopped(p, status = 'failed') {
  await client.query(
    "UPDATE execution_steps SET status='cancelled',finished_at=clock_timestamp() WHERE attempt_id=$1 AND status IN ('queued','running')",
    [p.attemptId],
  );
  await client.query(
    'UPDATE execution_attempts SET status=$2,finished_at=clock_timestamp(),next_run_at=null WHERE id=$1',
    [p.attemptId, status],
  );
  await client.query(
    'UPDATE tasks SET execution_status=$2,revision=revision+1,work_generation=work_generation+1 WHERE id=$1',
    [p.taskId, status],
  );
  const revision = (await client.query('SELECT revision FROM tasks WHERE id=$1', [p.taskId]))
    .rows[0].revision;
  return {
    expectedRevision: revision,
    previousAttemptId: p.attemptId,
    reason: '离线重新研究',
    authorizeResearch: true,
  };
}
async function counts(taskId) {
  return (
    await client.query(
      `SELECT
    (SELECT count(*)::int FROM project_selections WHERE task_id=$1) selections,
    (SELECT count(*)::int FROM execution_attempts WHERE task_id=$1) attempts,
    (SELECT count(*)::int FROM research_authorizations WHERE task_id=$1) authorizations,
    (SELECT count(*)::int FROM research_submissions WHERE task_id=$1) submissions,
    (SELECT count(*)::int FROM research_submission_materials WHERE task_id=$1) materials,
    (SELECT count(*)::int FROM execution_steps s JOIN execution_attempts a ON a.id=s.attempt_id WHERE a.task_id=$1) steps,
    (SELECT count(*)::int FROM audit_events WHERE task_id=$1) audits,
    (SELECT revision FROM tasks WHERE id=$1) revision`,
      [taskId],
    )
  ).rows[0];
}
async function faultAtCommit(run) {
  await client.query(
    "CREATE FUNCTION research_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline injected final write failure'; END; $$",
  );
  await client.query(
    'CREATE TRIGGER research_test_fault BEFORE INSERT ON idempotency_records FOR EACH ROW EXECUTE FUNCTION research_test_fault()',
  );
  try {
    return await run();
  } finally {
    await client.query('DROP TRIGGER research_test_fault ON idempotency_records');
    await client.query('DROP FUNCTION research_test_fault()');
  }
}

test('选题、授权、Supervisor 排队及幂等响应原子提交；同键重放保持原快照', async () => {
  const p = await prepared(),
    key = randomUUID();
  const responses = await Promise.all([
    post(p.taskId, 'project-selection', p.selectBody, { key }),
    post(p.taskId, 'project-selection', p.selectBody, { key }),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(responses.map((r) => r.json().meta.replayed).sort(), [false, true]);
  assert.equal(
    responses[0].json().data.authorization.id,
    responses[1].json().data.authorization.id,
  );
  const c = await counts(p.taskId);
  assert.equal(c.selections, 1);
  assert.equal(c.authorizations, 1);
  assert.equal(c.steps, 1);
  assert.equal(c.revision, 2);
  const row = (
    await client.query('SELECT * FROM research_authorizations WHERE task_id=$1', [p.taskId])
  ).rows[0];
  const scope = ResearchAuthorizationScopeSchema.parse(row.scope);
  assert.equal(row.consumed_at, null);
  assert.equal(scope.taskInput.originalRequest, '原始要求\r\n不能编造');
  assert.deepEqual(scope.sources.officialSites, []);
  const conflict = await post(
    p.taskId,
    'project-selection',
    { ...p.selectBody, candidateId: 'candidate-2' },
    { key },
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('不同键并发选不同候选只能成功一次；最后写入故障整体回滚', async () => {
  const p = await prepared();
  const responses = await Promise.all([
    post(p.taskId, 'project-selection', p.selectBody),
    post(p.taskId, 'project-selection', { ...p.selectBody, candidateId: 'candidate-2' }),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [202, 409]);
  const second = await prepared(),
    before = await counts(second.taskId),
    key = randomUUID();
  const failed = await faultAtCommit(() =>
    post(second.taskId, 'project-selection', second.selectBody, { key }),
  );
  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(await counts(second.taskId), before);
  assert.equal(
    (await post(second.taskId, 'project-selection', second.selectBody, { key })).statusCode,
    202,
  );
});

test('新 attempt 与新授权并发防重，保留原榜单选题和累计预算，报告链与补充资料清空', async () => {
  const p = await priorReport();
  const supplement = await post(p.taskId, 'research-supplements', {
    ...p.supplementBody,
    materials: [
      {
        clientRef: 'm-1',
        label: '补交',
        text: '旧补交资料',
        sourceUrl: null,
        confirmFirstHand: true,
      },
    ],
    officialSiteGrants: [{ origin: 'https://example.com', pathPrefix: '/docs/' }],
  });
  assert.equal(supplement.statusCode, 202, supplement.body);
  const body = await stopped(p);
  await client.query(
    'UPDATE task_execution_budgets SET calls=3,charged_tokens=120,charged_cost_micros_cny=200000 WHERE task_id=$1',
    [p.taskId],
  );
  const beforeBudget = (
    await client.query('SELECT * FROM task_execution_budgets WHERE task_id=$1', [p.taskId])
  ).rows[0];
  const responses = await Promise.all([
    post(p.taskId, 'research-attempt-retries', body),
    post(p.taskId, 'research-attempt-retries', body),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [202, 409]);
  const data = responses.find((r) => r.statusCode === 202).json().data;
  assert.notEqual(data.authorization.attemptId, p.attemptId);
  assert.equal(data.selection.selectionId, p.selected.selection.selectionId);
  const row = (
    await client.query('SELECT * FROM research_authorizations WHERE id=$1', [data.authorization.id])
  ).rows[0];
  assert.equal(row.base_result_id, null);
  assert.deepEqual(row.scope.materialRefs, []);
  assert.deepEqual(row.scope.sources.officialSites, []);
  assert.deepEqual(
    (await client.query('SELECT * FROM task_execution_budgets WHERE task_id=$1', [p.taskId]))
      .rows[0],
    beforeBudget,
  );
  assert.equal(
    (
      await client.query('SELECT count(*)::int n FROM github_hot_snapshots WHERE task_id=$1', [
        p.taskId,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        'SELECT count(*)::int n FROM execution_steps WHERE attempt_id=$1 AND result_id IS NOT NULL',
        [data.authorization.attemptId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(data.task.agentExecution.hotList.id, p.hotId);
});

test('重试最后写入失败回滚新 attempt、授权和任务指针', async () => {
  const p = await selected(),
    body = await stopped(p),
    before = await counts(p.taskId);
  const failed = await faultAtCommit(() => post(p.taskId, 'research-attempt-retries', body));
  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(await counts(p.taskId), before);
  assert.equal(
    (await client.query('SELECT current_attempt_id FROM tasks WHERE id=$1', [p.taskId])).rows[0]
      .current_attempt_id,
    p.attemptId,
  );
});

test('无资料的明确问题补查合法，补查授权与空提交批次一起创建且不提前消耗', async () => {
  const p = await priorReport();
  const response = await post(p.taskId, 'research-supplements', p.supplementBody);
  assert.equal(response.statusCode, 202, response.body);
  const data = response.json().data;
  assert.equal(data.authorization.mode, 'supplement');
  assert.equal(data.authorization.baseResultId, p.result.id);
  assert.ok(data.submissionId);
  const c = await counts(p.taskId);
  assert.equal(c.submissions, 1);
  assert.equal(c.materials, 0);
  assert.equal(
    (
      await client.query('SELECT consumed_at FROM research_authorizations WHERE id=$1', [
        data.authorization.id,
      ])
    ).rows[0].consumed_at,
    null,
  );
});

test('资料与一手确认同事务持久化，正文原样保留，既有材料确认生成新 ID/版本', async () => {
  const p = await priorReport();
  const text = '  一手资料\r\n保留原样。\n';
  const body = {
    ...p.supplementBody,
    materials: [
      {
        clientRef: 'text-1',
        label: '用户文本',
        text,
        sourceUrl: 'https://example.com/docs/page',
        confirmFirstHand: true,
      },
      {
        clientRef: 'link-1',
        label: '线索',
        text: null,
        sourceUrl: 'https://example.com/docs/',
        confirmFirstHand: false,
      },
    ],
    confirmExistingMaterials: [
      { materialId: p.material.id, materialVersion: 1, contentSha256: sha(p.material.content) },
    ],
    officialSiteGrants: [{ origin: 'https://EXAMPLE.com', pathPrefix: '/docs/' }],
  };
  const response = await post(p.taskId, 'research-supplements', body);
  assert.equal(response.statusCode, 202, response.body);
  const rows = (
    await client.query('SELECT * FROM research_submission_materials WHERE submission_id=$1', [
      response.json().data.submissionId,
    ])
  ).rows;
  assert.equal(rows.length, 3);
  const fresh = rows.find((r) => r.client_ref === 'text-1');
  assert.equal(fresh.record.material.content, text);
  assert.equal(fresh.content_sha256, sha(text));
  assert.equal(fresh.confirmed_by, actorId);
  assert.equal(fresh.record.material.firstHandConfirmation.materialVersion, 1);
  const confirmation = rows.find((r) => r.client_ref === null);
  assert.notEqual(confirmation.material_id, p.material.id);
  assert.equal(confirmation.material_version, 2);
  assert.equal(confirmation.lineage_root_material_id, p.material.id);
  assert.equal(rows.find((r) => r.client_ref === 'link-1').record.material, null);
  const old = (
    await client.query('SELECT validated_output FROM execution_steps WHERE result_id=$1', [
      p.result.id,
    ])
  ).rows[0].validated_output;
  assert.equal(old.materials.find((m) => m.id === p.material.id).firstHandConfirmation, null);
  await assert.rejects(
    client.query('UPDATE research_submission_materials SET client_ref=$2 WHERE id=$1', [
      fresh.id,
      'changed',
    ]),
    (e) => e.code === '23514',
  );
  // Even a link-only row cannot be appended after the authorized batch is committed.
  await assert.rejects(
    client.query(
      `INSERT INTO research_submission_materials
      (id,task_id,attempt_id,submission_id,client_ref,source_id,record)
      SELECT gen_random_uuid(),task_id,attempt_id,submission_id,'late-link',source_id,record
      FROM research_submission_materials WHERE submission_id=$1 AND client_ref='link-1'`,
      [response.json().data.submissionId],
    ),
    (error) => error.code === '23514',
  );
});

test('资料提交故障回滚所有资料/确认/授权，错误版本和未知问题不得产生部分提交', async () => {
  const p = await priorReport(),
    body = {
      ...p.supplementBody,
      materials: [
        { clientRef: 'm-1', label: '资料', text: '测试', sourceUrl: null, confirmFirstHand: true },
      ],
    };
  const before = await counts(p.taskId);
  const failed = await faultAtCommit(() => post(p.taskId, 'research-supplements', body));
  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(await counts(p.taskId), before);
  for (const changes of [
    { baseResultId: 'old-report' },
    { questionIds: ['unknown-question'] },
    { gapIds: ['unknown-gap'] },
    {
      confirmExistingMaterials: [
        { materialId: p.material.id, materialVersion: 1, contentSha256: '0'.repeat(64) },
      ],
    },
  ]) {
    const response = await post(p.taskId, 'research-supplements', { ...body, ...changes });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(await counts(p.taskId), before);
  }
});

test('同基版并发补查只创建一份待用授权；新请求不能覆盖等待授权', async () => {
  const p = await priorReport();
  const responses = await Promise.all([
    post(p.taskId, 'research-supplements', p.supplementBody),
    post(p.taskId, 'research-supplements', p.supplementBody),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [202, 409]);
  assert.equal((await counts(p.taskId)).submissions, 1);
});

test('未接通时三个接口均拒绝且零业务写入；鉴权先于参数校验', async () => {
  const p = await prepared(),
    closed = application(false),
    before = await counts(p.taskId);
  try {
    for (const [path, body] of [
      ['project-selection', p.selectBody],
      [
        'research-attempt-retries',
        {
          expectedRevision: 1,
          previousAttemptId: p.attemptId,
          reason: '重试',
          authorizeResearch: true,
        },
      ],
      [
        'research-supplements',
        {
          expectedRevision: 1,
          attemptId: p.attemptId,
          baseResultId: 'r',
          questionIds: ['q'],
          gapIds: [],
          materials: [],
          confirmExistingMaterials: [],
          officialSiteGrants: [],
          authorizeResearch: true,
        },
      ],
    ]) {
      const response = await post(p.taskId, path, body, { target: closed });
      assert.equal(response.statusCode, 503, response.body);
      const unauthenticated = await closed.inject({
        method: 'POST',
        url: `/api/v1/tasks/${p.taskId}/${path}`,
        payload: { invalid: true },
      });
      assert.equal(unauthenticated.statusCode, 401);
    }
    assert.deepEqual(await counts(p.taskId), before);
  } finally {
    await closed.close();
  }
});

test('旧重试入口、越团队候选、取消及已耗尽预算不能绕过研究约束', async () => {
  const p = await selected(),
    retryBody = await stopped(p);
  const legacy = await post(p.taskId, 'attempt-retries', {
    ...retryBody,
    authorizeResearch: undefined,
    restartTerminated: false,
  });
  assert.equal(legacy.statusCode, 409, legacy.body);
  await client.query(
    'UPDATE task_execution_budgets SET charged_cost_micros_cny=1000000 WHERE task_id=$1',
    [p.taskId],
  );
  assert.equal((await post(p.taskId, 'research-attempt-retries', retryBody)).statusCode, 409);
  const other = await prepared();
  const wrong = await post(other.taskId, 'project-selection', {
    ...other.selectBody,
    hotListSnapshotId: p.hotId,
  });
  assert.equal(wrong.statusCode, 409);
  await client.query(
    'UPDATE execution_attempts SET cancel_requested_at=clock_timestamp() WHERE id=$1',
    [other.attemptId],
  );
  assert.equal((await post(other.taskId, 'project-selection', other.selectBody)).statusCode, 409);
});

test('停止与选题并发由同一任务事务串行化，不会留下停止后的新授权', async () => {
  const p = await prepared();
  const responses = await Promise.all([
    post(p.taskId, 'project-selection', p.selectBody),
    post(p.taskId, `attempts/${p.attemptId}/stop`, { expectedRevision: 1, reason: '人工停止' }),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [202, 409]);
  const current = (await client.query('SELECT execution_status FROM tasks WHERE id=$1', [p.taskId]))
    .rows[0];
  assert.equal(
    (await counts(p.taskId)).authorizations,
    current.execution_status === 'cancelled' ? 0 : 1,
  );
});

test('严格 JSON 类型与 CSRF 在提交前校验，任务版本冲突返回最新版本', async () => {
  const p = await prepared(),
    initial = await counts(p.taskId);
  for (const changes of [
    { authorizeResearch: 'true' },
    { expectedRevision: '1' },
    { newQuestions: ['越权问题'] },
  ]) {
    const response = await post(p.taskId, 'project-selection', { ...p.selectBody, ...changes });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(response.json().error.fieldErrors.length);
  }
  const noCsrf = await post(p.taskId, 'project-selection', p.selectBody, {
    headers: { 'x-csrf-token': 'invalid' },
  });
  assert.equal(noCsrf.statusCode, 403);
  const conflict = await post(p.taskId, 'project-selection', {
    ...p.selectBody,
    expectedRevision: 99,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.conflict.actualRevision, 1);
  assert.deepEqual(await counts(p.taskId), initial);
});

test('跨团队不可读写，身份撤销后不可重放原成功响应', async () => {
  const p = await prepared(),
    key = randomUUID();
  assert.equal((await post(p.taskId, 'project-selection', p.selectBody, { key })).statusCode, 202);
  const otherTeam = (
    await client.query("INSERT INTO teams(name) VALUES ('other team') RETURNING id")
  ).rows[0].id;
  await client.query(
    "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'research.other',$2,'另一团队','operator')",
    [otherTeam, await hashPassword('offline-research-password')],
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login: 'research.other', password: 'offline-research-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const outsider = {
    cookie: login.headers['set-cookie'].split(';')[0],
    'x-csrf-token': login.json().data.csrfToken,
  };
  const forbidden = await post(p.taskId, 'project-selection', p.selectBody, {
    key,
    headers: outsider,
  });
  assert.equal(forbidden.statusCode, 404);
  await client.query(
    "UPDATE members SET status='disabled',auth_version=auth_version+1 WHERE id=$1",
    [actorId],
  );
  assert.equal((await post(p.taskId, 'project-selection', p.selectBody, { key })).statusCode, 401);
});

test('数据库提交时拒绝缺少资料批次的补查授权', async () => {
  const p = await priorReport(),
    before = await counts(p.taskId);
  const scope = (
    await client.query('SELECT scope FROM research_authorizations WHERE id=$1', [
      p.selected.authorization.id,
    ])
  ).rows[0].scope;
  scope.mode = 'supplement';
  scope.baseResult = { id: p.result.id, version: 1 };
  scope.submissionId = randomUUID();
  scope.supplementScope = {
    questions: p.result.report.questions.map(({ id, question, severity, reason }) => ({
      id,
      question,
      severity,
      reason,
    })),
    gaps: p.result.report.gaps,
  };
  await assert.rejects(
    client.query(
      "INSERT INTO research_authorizations(task_id,attempt_id,selection_id,mode,scope,base_result_id,authorized_by) VALUES ($1,$2,$3,'supplement',$4,$5,$6)",
      [p.taskId, p.attemptId, p.selected.selection.selectionId, scope, p.result.id, actorId],
    ),
    (error) => error.code === '23514',
  );
  assert.deepEqual(await counts(p.taskId), before);
});

test('新尝试的批准失效与指针清除参与同一事务，失败恢复原批准', async () => {
  const p = await selected(),
    body = await stopped(p);
  const accountId = randomUUID(),
    contentId = randomUUID(),
    reviewId = randomUUID(),
    approvalId = randomUUID();
  const now = new Date().toISOString(),
    text = '已批准的历史正文';
  await client.query('INSERT INTO accounts(id,team_id,display_name) VALUES ($1,$2,$3)', [
    accountId,
    teamId,
    '离线账号',
  ]);
  await client.query(
    "INSERT INTO config_versions(account_id,version,profile,tone,model_ref,prompt_version,tool_version,change_reason,updated_by) VALUES ($1,1,'介绍工具','客观','offline','offline-v1','offline-v1','测试',$2)",
    [accountId, actorId],
  );
  await client.query('UPDATE accounts SET current_config_version=1 WHERE id=$1', [accountId]);
  await client.query(
    "INSERT INTO task_contents(id,task_id,source_kind,version_no,body,content_hash,created_by) VALUES ($1,$2,'manual',1,$3,$4,$5)",
    [contentId, p.taskId, text, sha(text), actorId],
  );
  const review = {
    id: reviewId,
    taskId: p.taskId,
    attemptId: null,
    trigger: 'manual_submit',
    inputVersionId: contentId,
    currentVersionId: contentId,
    status: 'completed',
    records: [],
    requestedBy: actorId,
    configVersion: 1,
    createdAt: now,
    finishedAt: now,
    error: null,
  };
  await client.query(
    'INSERT INTO task_review_cycles(id,task_id,content_version_id,config_version,data) VALUES ($1,$2,$3,1,$4)',
    [reviewId, p.taskId, contentId, review],
  );
  const approval = {
    id: approvalId,
    taskId: p.taskId,
    contentVersionId: contentId,
    contentHash: sha(text),
    accountId,
    reviewCycleId: reviewId,
    status: 'approved',
    approvedBy: actorId,
    approvedAt: now,
    invalidatedAt: null,
    invalidatedReason: null,
  };
  await client.query(
    'INSERT INTO task_version_approvals(id,task_id,content_version_id,review_cycle_id,account_id,config_version,data) VALUES ($1,$2,$3,$4,$5,1,$6)',
    [approvalId, p.taskId, contentId, reviewId, accountId, approval],
  );
  await client.query(
    "UPDATE tasks SET account_id=$2,current_content_version_id=$3,current_review_cycle_id=$4,current_approval_id=$5,approval_status='approved' WHERE id=$1",
    [p.taskId, accountId, contentId, reviewId, approvalId],
  );
  const failed = await faultAtCommit(() => post(p.taskId, 'research-attempt-retries', body));
  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(
    (await client.query('SELECT data FROM task_version_approvals WHERE id=$1', [approvalId]))
      .rows[0].data,
    approval,
  );
  assert.equal(
    (await client.query('SELECT current_approval_id FROM tasks WHERE id=$1', [p.taskId])).rows[0]
      .current_approval_id,
    approvalId,
  );
  const response = await post(p.taskId, 'research-attempt-retries', body);
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.task.task.currentContentVersionId, null);
  assert.equal(response.json().data.task.task.currentReviewCycleId, null);
  assert.equal(response.json().data.task.task.currentApprovalId, null);
  assert.equal(
    (await client.query('SELECT data FROM task_version_approvals WHERE id=$1', [approvalId]))
      .rows[0].data.status,
    'invalidated',
  );
});
