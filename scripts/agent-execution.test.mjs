import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { createApp } from '../backend/src/app.ts';
import { AuthService } from '../backend/src/auth.ts';
import { hashPassword } from '../backend/src/password.ts';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { TaskService } from '../backend/src/task-service.ts';
import { AgentTaskExecutor } from '../backend/src/agent-task-executor.ts';
import { AgentClient } from '../backend/src/agent-client.ts';
import { readAgentExecutionLimits } from '../backend/src/agent-execution-config.ts';
import { createAgentService } from '../agent/src/service.ts';
import { runSupervisor } from '../agent/src/agents/supervisor/runtime.ts';
import { parseGithubHot, GITHUB_HOT_API_URL } from '../agent/src/integrations/xxapi/github-hot.ts';
import { runMigrations } from './migrations.mjs';

// Offline external providers, real loopback HTTP, disposable database and runtime role.
// Never migrates/seeds the business database or sends model/XXAPI requests.
const explicitAdmin = process.env.AGENT_TEST_ADMIN_URL;
if (!explicitAdmin)
  throw new Error(
    '需要显式 AGENT_TEST_ADMIN_URL，指向可创建隔离测试库的本机测试实例；不读取业务配置。',
  );
const adminUrl = new URL(explicitAdmin);
if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname))
  throw new Error('Agent 集成测试只使用本机 PostgreSQL。');
const suffix = randomBytes(6).toString('hex');
const databaseName = `agent_test_${suffix}`,
  roleName = `agent_app_${suffix}`;
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
const token = randomBytes(32).toString('hex');
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
let dbCreated = false,
  roleCreated = false,
  client,
  database,
  app,
  agent,
  executor,
  identity,
  backendBase;
let hotCalls,
  sdkCalls,
  contexts,
  heldSignals,
  lastRequest,
  emptyHotList = false;

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
async function closeApplications() {
  if (executor) {
    await executor.stop();
    executor = undefined;
  }
  if (agent) {
    await agent.close();
    agent = undefined;
  }
  if (app) {
    await app.close();
    app = undefined;
  }
}
beforeEach(async () => {
  await closeApplications();
  await client.query('TRUNCATE teams,tasks,idempotency_records CASCADE');
  hotCalls = 0;
  sdkCalls = 0;
  contexts = [];
  heldSignals = [];
  lastRequest = null;
  emptyHotList = false;
  const teamId = (
    await client.query("INSERT INTO teams(name) VALUES ('offline Agent team') RETURNING id")
  ).rows[0].id;
  await client.query(
    "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'agent.admin',$2,'离线测试成员','admin')",
    [teamId, await hashPassword('offline-agent-password')],
  );
  app = createApp({
    logging: false,
    auth: new AuthService(database.db, {
      secret: randomBytes(32),
      trustedOrigins: [origin],
      secureCookie: false,
    }),
    tasks: new TaskService(database.db, () => new Date(), {
      executorMode: 'agent',
      agentConfiguration: configuration,
      executionLimits: readAgentExecutionLimits({}),
    }),
    agentRuns: {
      serviceToken: token,
      checkRun: (request) => {
        lastRequest = request;
        return executor.checkRun(request);
      },
    },
    checkDatabase: async () => ({ status: 'ready', database: 'connected' }),
    checkAgent: async () => {
      throw new Error('not used');
    },
  });
  backendBase = await app.listen({ port: 0, host: '127.0.0.1' });
  agent = createAgentService({
    serviceToken: token,
    backendBaseUrl: backendBase,
    env: { DEEPSEEK_API_KEY: 'offline-never-sent' },
    acquireHotList: async () => {
      hotCalls++;
      return parseGithubHot({
        provider: 'xxapi',
        requestUrl: GITHUB_HOT_API_URL,
        fetchedAt: new Date().toISOString(),
        data: {
          code: 200,
          data: emptyHotList
            ? []
            : [{ title: 'fixture', desc: '离线候选', url: 'https://github.com/example/fixture' }],
        },
      });
    },
    run: (context, options) =>
      runSupervisor(context, {
        ...options,
        query: ({ options: sdkOptions }) => {
          sdkCalls++;
          contexts.push(context);
          const session = (async function* () {
            if (context.task.originalRequest.includes('校验拒绝后限额')) {
              for (const group of sdkOptions.hooks.PreToolUse)
                for (const callback of group.hooks) {
                  const denied = await callback(
                    {
                      hook_event_name: 'PreToolUse',
                      session_id: 'offline-session',
                      cwd: sdkOptions.cwd,
                      tool_name: 'StructuredOutput',
                      tool_use_id: 'offline-output',
                      tool_input: {
                        decision: 'awaiting_selection',
                        summary: 'private-model-summary',
                        basisRefs: ['hotList.id'],
                        defaultsUsed: [],
                        warnings: [],
                        hotListSnapshotId: context.hotList.id,
                      },
                    },
                    'offline-output',
                    { signal: options.signal },
                  );
                  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
                }
              yield {
                type: 'assistant',
                message: {
                  id: 'offline-over-limit',
                  content: [],
                  usage: { input_tokens: 100001, output_tokens: 1 },
                },
              };
              return;
            }
            if (context.task.originalRequest.includes('诊断缺少结构化输出')) {
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'private-model-text',
              };
              return;
            }
            if (context.task.originalRequest.includes('执行失败'))
              throw new Error('offline SDK failure');
            if (context.task.originalRequest.includes('等待取消')) {
              heldSignals.push(options.signal);
              await new Promise((_resolve, reject) =>
                options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                  once: true,
                }),
              );
            }
            const common = {
              summary: '离线显式决定',
              basisRefs: ['task.originalRequest'],
              defaultsUsed: [],
              warnings: [],
            };
            const requiresAnswer =
              context.task.originalRequest.includes('需要澄清') &&
              !context.clarifications.some((question) => question.answer === '已明确');
            const decision = requiresAnswer
              ? {
                  ...common,
                  decision: 'needs_clarification',
                  questions: [
                    { kind: 'missing_requirement', question: '请明确受众', reason: '当前要求不足' },
                  ],
                }
              : {
                  ...common,
                  decision: 'awaiting_selection',
                  hotListSnapshotId: context.hotList.id,
                };
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: randomUUID(),
              num_turns: 1,
              total_cost_usd: 0,
              modelUsage: {
                'deepseek-flash': {
                  inputTokens: 100,
                  outputTokens: 20,
                  cacheReadInputTokens: 10,
                  cacheCreationInputTokens: 0,
                },
              },
              structured_output: decision,
            };
          })();
          return Object.assign(session, { close() {} });
        },
      }),
  });
  agent.server.listen(0, '127.0.0.1');
  await once(agent.server, 'listening');
  executor = new AgentTaskExecutor(
    database.db,
    new AgentClient({
      baseUrl: `http://127.0.0.1:${agent.server.address().port}`,
      serviceToken: token,
    }),
    { pollMs: 10, heartbeatMs: 20, leaseMs: 1000 },
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login: 'agent.admin', password: 'offline-agent-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  identity = {
    cookie: login.headers['set-cookie'].split(';')[0],
    'x-csrf-token': login.json().data.csrfToken,
  };
  executor.start();
});
after(async () => {
  await closeApplications();
  if (database) await database.close();
  if (client) await client.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
  if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
  await admin.end();
});
async function api(method, path, payload, status = 200, key = randomUUID()) {
  const result = await app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload ? { payload } : {}),
    headers: { origin, ...identity, 'idempotency-key': key },
  });
  assert.equal(result.statusCode, status, result.body);
  return result.json();
}
async function start(originalRequest = '介绍一个 GitHub 项目') {
  const created = (await api('POST', '/tasks', { title: '离线真实执行链路', originalRequest }, 201))
    .data;
  assert.equal(created.agentExecution.executorMode, 'agent');
  return (
    await api(
      'POST',
      `/tasks/${created.task.id}/attempts`,
      { expectedRevision: created.task.revision },
      202,
    )
  ).data;
}
async function waitFor(taskId, expected) {
  const until = Date.now() + 10000;
  let detail;
  while (Date.now() < until) {
    detail = (await api('GET', `/tasks/${taskId}`)).data;
    if (detail.execution === expected) return detail;
    if (detail.execution === 'failed' && expected !== 'failed')
      throw new Error(JSON.stringify(detail.currentAttempt.error));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(
    `status timeout: ${detail?.execution}; ${JSON.stringify(detail?.currentAttempt?.error)}`,
  );
}

test('后端经独立 HTTP Agent 调用 runSupervisor，保存热榜、冻结输入、决定和一次模型汇总记账', async () => {
  const initial = await start();
  const ready = await waitFor(initial.task.id, 'awaiting_selection');
  assert.equal(hotCalls, 1);
  assert.equal(sdkCalls, 1);
  assert.equal(ready.currentAttempt.id, initial.currentAttempt.id);
  assert.equal(ready.currentAttempt.finishedAt, null);
  assert.equal(ready.agentExecution.hotList.items.length, 1);
  assert.equal(ready.agentExecution.lastDecision.decision, 'awaiting_selection');
  const row = (
    await client.query(
      'SELECT executor_id,active_since,next_run_at FROM execution_attempts WHERE id=$1',
      [ready.currentAttempt.id],
    )
  ).rows[0];
  assert.deepEqual(row, { executor_id: null, active_since: null, next_run_at: null });
  const history = (await api('GET', `/tasks/${initial.task.id}/history`)).data;
  assert.equal(history.steps.length, 2);
  assert.equal(history.calls.length, 2);
  assert.equal(history.calls.filter((call) => call.kind === 'model').length, 1);
  assert.equal(history.budget.chargedTokens, 130);
  assert.equal(history.budget.chargedCostMicrosCny, 150);
  const privateCheck = await fetch(`${backendBase}/internal/v1/agent-runs/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(lastRequest),
  });
  assert.equal(privateCheck.status, 409); // Completed runs lose write authority.
});

test('非空答复仍交给 Supervisor 重新判断；同 attempt 继续澄清且不重复抓榜', async () => {
  const initial = await start('需要澄清');
  let detail = await waitFor(initial.task.id, 'awaiting_clarification');
  const answer = async (text) => {
    await api(
      'POST',
      `/tasks/${initial.task.id}/clarifications`,
      {
        expectedRevision: detail.task.revision,
        attemptId: detail.currentAttempt.id,
        answers: detail.task.clarifications
          .filter((q) => q.answer === null)
          .map((q) => ({ questionId: q.questionId, answer: text })),
      },
      202,
    );
  };
  await answer('仍不明确');
  detail = await waitFor(initial.task.id, 'awaiting_clarification');
  assert.equal(sdkCalls, 2);
  assert.equal(detail.task.clarifications.length, 2);
  assert.equal(contexts[1].clarifications[0].answer, '仍不明确');
  await answer('已明确');
  detail = await waitFor(initial.task.id, 'awaiting_selection');
  assert.equal(detail.currentAttempt.id, initial.currentAttempt.id);
  assert.equal(hotCalls, 1);
  assert.equal(sdkCalls, 3);
  assert.equal(detail.task.clarifications[0].answer, '仍不明确');
});

test('诊断从真实 Agent HTTP 失败传回后端并保存，模型正文不保存', async () => {
  const initial = await start('诊断缺少结构化输出');
  const detail = await waitFor(initial.task.id, 'failed');
  const steps = (
    await client.query(
      'SELECT runtime_metadata FROM execution_steps WHERE attempt_id=$1 AND frozen_input IS NOT NULL',
      [detail.task.currentAttemptId],
    )
  ).rows;
  assert.ok(
    steps.some(
      (s) =>
        s.runtime_metadata?.structuredOutputDiagnostic?.errorType === 'missing_structured_output',
    ),
  );
  assert.ok(!JSON.stringify(steps).includes('private-model-text'));
  assert.equal(sdkCalls, 1);
});

test('先拒绝后触发 Token 上限，原拒绝码及字段路径仍经 HTTP 持久化', async () => {
  const initial = await start('校验拒绝后限额');
  const detail = await waitFor(initial.task.id, 'failed');
  assert.equal(detail.currentAttempt.error.code, 'SUPERVISOR_TOKEN_LIMIT');
  const steps = (
    await client.query(
      'SELECT runtime_metadata FROM execution_steps WHERE attempt_id=$1 AND frozen_input IS NOT NULL',
      [detail.task.currentAttemptId],
    )
  ).rows;
  const trace = steps.find((s) => s.runtime_metadata?.structuredOutputDiagnostic)?.runtime_metadata
    .structuredOutputDiagnostic.sdkTrace;
  assert.equal(trace.outputRejections[0].code, 'SUPERVISOR_REFERENCE_INVALID');
  assert.deepEqual(trace.outputRejections[0].issues, [
    { path: 'basisRefs.0', code: 'semantic_mismatch' },
  ]);
  assert.deepEqual(trace.outputRejections[0].referenceFailure.invalidReferences, [
    {
      path: 'basisRefs.0',
      value: 'hotList.id',
      truncated: false,
      reason: 'not_in_allowed_context_reference_set',
    },
  ]);
  assert.ok(trace.tokenObservation.observed >= trace.tokenObservation.limit);
  assert.ok(!JSON.stringify(steps).includes('private-model-summary'));
  assert.equal(sdkCalls, 1);
});

test('SDK 失败结束 attempt，未知费用保留预占，不自动重试', async () => {
  const initial = await start('执行失败');
  const detail = await waitFor(initial.task.id, 'failed');
  assert.equal(detail.currentAttempt.error.code, 'SUPERVISOR_SDK_FAILED');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sdkCalls, 1);
  assert.equal(hotCalls, 1);
  const calls = (
    await client.query(
      "SELECT tokens_known,cost_known,charged_tokens FROM task_execution_calls WHERE task_id=$1 AND kind='model'",
      [initial.task.id],
    )
  ).rows;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokens_known, false);
  assert.equal(calls[0].cost_known, false);
  assert.equal(Number(calls[0].charged_tokens), 100000);
});

test('停止会 fence 旧代次并取消远端 SDK，迟到结果不写入且不重试', async () => {
  const initial = await start('等待取消');
  const until = Date.now() + 5000;
  while (!heldSignals.length && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(heldSignals.length, 1);
  const duplicateClaim = await fetch(`${backendBase}/internal/v1/agent-runs/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...lastRequest, phase: 'begin' }),
  });
  assert.equal(duplicateClaim.status, 409);
  const running = (await api('GET', `/tasks/${initial.task.id}`)).data;
  await api(
    'POST',
    `/tasks/${initial.task.id}/attempts/${running.currentAttempt.id}/stop`,
    { expectedRevision: running.task.revision, reason: '离线取消验证' },
    202,
  );
  await waitFor(initial.task.id, 'cancelled');
  const cancelledUntil = Date.now() + 3000;
  while (!heldSignals[0].aborted && Date.now() < cancelledUntil)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(heldSignals[0].aborted, true);
  assert.equal(sdkCalls, 1);
  const result = await client.query(
    'SELECT validated_output FROM execution_steps WHERE attempt_id=$1 AND frozen_input IS NOT NULL',
    [running.currentAttempt.id],
  );
  assert.equal(result.rows[0].validated_output, null);
});

test('空榜单可回查，明确失败且不调用模型', async () => {
  emptyHotList = true;
  const initial = await start();
  const detail = await waitFor(initial.task.id, 'failed');
  assert.equal(detail.currentAttempt.error.code, 'GITHUB_HOT_EMPTY');
  assert.equal(hotCalls, 1);
  assert.equal(sdkCalls, 0);
  assert.deepEqual(detail.agentExecution.hotList.items, []);
});
