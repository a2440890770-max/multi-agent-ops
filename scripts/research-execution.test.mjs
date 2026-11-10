import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import { createApp } from '../backend/src/app.ts';
import { AuthService } from '../backend/src/auth.ts';
import { hashPassword } from '../backend/src/password.ts';
import { createBusinessDatabase } from '../backend/src/database.ts';
import { TaskService } from '../backend/src/task-service.ts';
import { AgentTaskExecutor } from '../backend/src/agent-task-executor.ts';
import { AgentClient } from '../backend/src/agent-client.ts';
import {
  readAgentConfiguration,
  readAgentExecutionLimits,
} from '../backend/src/agent-execution-config.ts';
import { ResearchExecutionService } from '../backend/src/research-execution-service.ts';
import { createAgentService } from '../agent/src/service.ts';
import { runSupervisor } from '../agent/src/agents/supervisor/runtime.ts';
import { parseGithubHot, GITHUB_HOT_API_URL } from '../agent/src/integrations/xxapi/github-hot.ts';
import { validateResearchResult } from '../shared/src/index.ts';
import { runMigrations } from './migrations.mjs';

// Real local HTTP and PostgreSQL; only the SDK stream, public DNS and original web reader are fixtures.
const raw = process.env.RESEARCH_TEST_ADMIN_URL;
if (!raw || !['127.0.0.1', 'localhost'].includes(new URL(raw).hostname))
  throw new Error('需要显式本机隔离 RESEARCH_TEST_ADMIN_URL。');
const adminUrl = new URL(raw),
  suffix = randomBytes(6).toString('hex');
const dbName = `research_run_test_${suffix}`,
  roleName = `research_run_app_${suffix}`;
const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
const token = randomBytes(32).toString('hex'),
  origin = 'http://127.0.0.1:5173';
const configuration = readAgentConfiguration({
  TASK_RESEARCH_ENABLED: 'true',
  TASK_WEB_REQUEST_MICROS_CNY: '5000',
  TASK_MODEL_PRICING_VERSION: 'offline-peak-v1',
  TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION: '2000000',
  TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '8000000',
  AGENT_SESSION_MAX_BUDGET_USD: '0.10',
});
configuration.maxSessionTokens = 12000; // Explicit small offline reservation leaves room to verify a manual retry.
let client,
  database,
  app,
  agent,
  executor,
  identity,
  backendBase,
  directory,
  dbCreated = false,
  roleCreated = false;
let sdkCalls = 0,
  hotCalls = 0,
  researchDispatches = 0,
  deniedFetches = 0,
  corrections = 0;
let scenario = 'ready',
  held = false,
  observedSignal,
  callbacks = [],
  rejections = [];
const bodyText = '项目可以整理输入文本。项目文档说明了维护方式。';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const common = {
  summary: '离线 Supervisor 决定',
  basisRefs: ['task.originalRequest'],
  defaultsUsed: [],
  warnings: [],
};

async function hook(options, event, values) {
  let output = {};
  for (const group of options.hooks?.[event] ?? [])
    for (const callback of group.hooks)
      output = await callback(
        { hook_event_name: event, session_id: 'offline-sdk-session', cwd: options.cwd, ...values },
        values.tool_use_id,
        { signal: options.abortController.signal },
      );
  return output;
}
function reportFor(context, records, partial) {
  const old = context.previousReport?.report;
  const question = context.request.questions[0];
  const original = records.materials.filter((m) => m.kind === 'webpage_text').at(-1);
  const evidence = {
    id: `evidence-${context.authorization.id}`,
    sourceId: original.sourceId,
    materialId: original.id,
    excerpt: original.content,
    directness: 'direct',
    locator: { kind: 'text', startOffset: 0, endOffset: original.content.length },
  };
  const claim = {
    id: `claim-${context.authorization.id}`,
    kind: 'fact',
    statement: '项目可以整理输入文本。',
    attribution: null,
    evidenceIds: [evidence.id],
    refutingEvidenceIds: [],
    premiseClaimIds: [],
    questionIds: [question.id],
    limitations: [],
  };
  const claims = [...(old?.claims ?? []), claim];
  const gaps = partial
    ? [
        {
          id: 'gap-core',
          questionIds: [question.id],
          sectionIds: [],
          severity: 'core',
          claim: '维护方式需要进一步核实。',
          impact: '影响核心介绍',
          requestedMaterial: '补充正式说明',
        },
      ]
    : [];
  return {
    schemaVersion: '1.0',
    status: partial ? 'partial' : 'completed',
    summary: '离线固定资料研究报告，仅验证接线。',
    questions: [
      {
        ...question,
        origin: old?.questions[0]?.origin ?? 'supervisor',
        status: partial ? 'partial' : 'answered',
        claimIds: claims.map((c) => c.id),
        gapIds: gaps.map((g) => g.id),
      },
    ],
    claims,
    sections: context.runtimeContext.skills[0].requiredSections.map((r) => ({
      id: `section-${r.id}`,
      title: r.title,
      requirementRef: r.id,
      status: 'supported',
      claimIds: claims.map((c) => c.id),
      gapIds: [],
    })),
    evidence: [...(old?.evidence ?? []), evidence],
    gaps,
    conflicts: [],
    suggestedAngles: [],
    warnings: [],
    changes: old
      ? [
          {
            kind: 'added',
            previousRef: null,
            currentRef: claim.id,
            reason: '补充本轮已读取证据。',
          },
          ...old.gaps.map((g) => ({
            kind: 'gap_resolved',
            previousRef: g.id,
            currentRef: null,
            reason: '本轮完成核对。',
          })),
        ]
      : [],
  };
}
async function* sdk(context, runOptions, options) {
  sdkCalls++;
  yield { type: 'system', subtype: 'init', session_id: 'offline-sdk-session' };
  let decision;
  if (!context.selectedProject)
    decision = { ...common, decision: 'awaiting_selection', hotListSnapshotId: context.hotList.id };
  else if (scenario === 'clarify' && !context.clarifications.some((q) => q.answer))
    decision = {
      ...common,
      decision: 'needs_clarification',
      questions: [{ kind: 'missing_requirement', question: '请明确受众', reason: '要求仍不充分' }],
    };
  else {
    const previous = runOptions.acceptedResearchResults?.at(-1);
    const questions =
      context.researchContext.inputs.mode === 'supplement'
        ? previous.report.questions
            .filter((q) =>
              context.researchContext.inputs.supplementScope.questionIds.includes(q.id),
            )
            .map(({ id, question, severity, reason }) => ({ id, question, severity, reason }))
        : [
            {
              id: 'question-feature',
              question: '项目功能及维护方式是什么？',
              severity: 'core',
              reason: '介绍核心信息',
            },
          ];
    const request = {
      topic: context.selectedProject.name,
      objective: '核对当前项目',
      questions,
      scope: { inclusions: [context.selectedProject.name], exclusions: ['其他项目'] },
      referenceIds: [],
    };
    const dispatchId = `dispatch-${randomUUID()}`,
      agentId = `research-${randomUUID()}`;
    const pre = await hook(options, 'PreToolUse', {
      tool_name: 'Agent',
      tool_use_id: dispatchId,
      tool_input: {
        subagent_type: 'research',
        description: '项目研究',
        prompt: JSON.stringify(request),
        run_in_background: false,
      },
    });
    assert.equal(
      pre.hookSpecificOutput?.permissionDecision,
      'allow',
      JSON.stringify(rejections.map((e) => e.message)),
    );
    researchDispatches++;
    await hook(options, 'SubagentStart', { agent_id: agentId, agent_type: 'research' });
    const runTool = async (name, input, response) => {
      const id = randomUUID();
      const allowed = await hook(options, 'PreToolUse', {
        agent_id: agentId,
        tool_name: name,
        tool_use_id: id,
        tool_input: input,
      });
      assert.equal(
        allowed.hookSpecificOutput?.permissionDecision,
        'allow',
        JSON.stringify(rejections.map((e) => e.message)),
      );
      return hook(options, 'PostToolUse', {
        agent_id: agentId,
        tool_name: name,
        tool_use_id: id,
        tool_input: input,
        tool_response: response,
      });
    };
    if (scenario === 'held') {
      held = true;
      observedSignal = runOptions.signal;
      await new Promise((_resolve, reject) =>
        runOptions.signal.addEventListener('abort', () => reject(new Error('cancelled offline')), {
          once: true,
        }),
      );
    }
    for (const domain of ['bilibili.com', 'xiaohongshu.com', 'douyin.com'])
      await runTool(
        'WebSearch',
        { query: `${context.selectedProject.name} site:${domain}`, allowed_domains: [domain] },
        { results: [] },
      );
    const fetch = (url) =>
      runTool(
        'WebFetch',
        { url, prompt: '读取原文' },
        { code: 200, url, result: 'SDK 处理结果只作线索' },
      );
    await fetch(context.selectedProject.repositoryUrl);
    // A discovered external documentation link must be separately authorized every round.
    const external = 'https://example.com/docs/';
    const externalId = randomUUID();
    const permit = await hook(options, 'PreToolUse', {
      agent_id: agentId,
      tool_name: 'WebFetch',
      tool_use_id: externalId,
      tool_input: { url: external, prompt: '读取说明' },
    });
    if (permit.hookSpecificOutput?.permissionDecision === 'allow')
      await hook(options, 'PostToolUse', {
        agent_id: agentId,
        tool_name: 'WebFetch',
        tool_use_id: externalId,
        tool_response: { code: 200, url: external, result: '文档线索' },
      });
    else deniedFetches++;
    const researchContext = JSON.parse(
      pre.hookSpecificOutput.updatedInput.prompt.split('\n').slice(1).join('\n'),
    ).researchContext;
    const records = await runOptions.research.webTools.getRecords();
    const report = reportFor(
      researchContext,
      records,
      scenario === 'partial' && researchContext.authorization.mode === 'initial',
    );
    if (scenario === 'repair' || scenario === 'invalid') {
      const rejected = await hook(options, 'SubagentStop', {
        agent_id: agentId,
        agent_type: 'research',
        stop_hook_active: false,
        last_assistant_message: 'invalid report',
      });
      assert.equal(rejected.decision, 'block');
      corrections++;
      const forbidden = await hook(options, 'PreToolUse', {
        agent_id: agentId,
        tool_name: 'WebSearch',
        tool_use_id: randomUUID(),
        tool_input: { query: 'fixture site:douyin.com', allowed_domains: ['douyin.com'] },
      });
      assert.equal(forbidden.hookSpecificOutput?.permissionDecision, 'deny');
      if (scenario === 'invalid') {
        await hook(options, 'SubagentStop', {
          agent_id: agentId,
          agent_type: 'research',
          stop_hook_active: true,
          last_assistant_message: 'invalid again',
        });
        const exhausted = await hook(options, 'SubagentStop', {
          agent_id: agentId,
          agent_type: 'research',
          stop_hook_active: true,
          last_assistant_message: 'still invalid',
        });
        assert.equal(exhausted.continue, false);
        throw new Error('no usable report');
      }
    }
    const stopped = await hook(options, 'SubagentStop', {
      agent_id: agentId,
      agent_type: 'research',
      stop_hook_active: false,
      last_assistant_message: JSON.stringify(report),
    });
    assert.notEqual(stopped.continue, false, JSON.stringify(rejections.map((e) => e.message)));
    assert.notEqual(stopped.decision, 'block');
    const accepted = await hook(options, 'PostToolUse', {
      tool_name: 'Agent',
      tool_use_id: dispatchId,
      tool_response: {
        status: 'completed',
        agentId,
        content: [{ type: 'text', text: JSON.stringify(report) }],
      },
    });
    assert.notEqual(accepted.continue, false, JSON.stringify(rejections.map((e) => e.message)));
    const result = accepted.hookSpecificOutput.updatedToolOutput.researchResult;
    if (scenario === 'supervisor-fail') throw new Error('failure after adopted Research');
    decision =
      report.status === 'partial'
        ? {
            ...common,
            decision: 'needs_materials',
            researchResultId: result.id,
            blockingGaps: report.gaps.map((g) => ({
              researchGapId: g.id,
              impact: g.impact,
              requestedMaterial: g.requestedMaterial,
            })),
          }
        : {
            ...common,
            decision: 'ready_for_content',
            researchResultId: result.id,
            contentBrief: {
              topic: context.selectedProject.name,
              objective: '介绍项目',
              constraints: [],
              usableClaimIds: report.claims.map((c) => c.id),
              exclusions: [],
            },
          };
  }
  const final = await hook(options, 'PreToolUse', {
    tool_name: 'StructuredOutput',
    tool_use_id: randomUUID(),
    tool_input: decision,
  });
  assert.equal(final.hookSpecificOutput?.permissionDecision, 'allow');
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'offline-sdk-session',
    num_turns: 3,
    total_cost_usd: 0.001,
    modelUsage: {
      'deepseek-flash': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    structured_output: decision,
  };
}

before(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  dbCreated = true;
  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;
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
  directory = await mkdtemp(join(tmpdir(), 'research-execution-offline-'));
});
async function close() {
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
  await close();
  await client.query('TRUNCATE teams,tasks,idempotency_records CASCADE');
  sdkCalls = 0;
  hotCalls = 0;
  researchDispatches = 0;
  deniedFetches = 0;
  corrections = 0;
  scenario = 'ready';
  held = false;
  callbacks = [];
  rejections = [];
  const teamId = (
    await client.query("INSERT INTO teams(name) VALUES ('offline execution') RETURNING id")
  ).rows[0].id;
  await client.query(
    "INSERT INTO members(team_id,login,password_hash,display_name,role) VALUES ($1,'research.runner',$2,'离线验收','admin')",
    [teamId, await hashPassword('offline-research-password')],
  );
  const research = new ResearchExecutionService(database.db, (error) => rejections.push(error));
  app = createApp({
    logging: false,
    auth: new AuthService(
      database.db,
      { secret: randomBytes(32), trustedOrigins: [origin], secureCookie: false },
      { accountAttempts: 100, ipAttempts: 100 },
    ),
    tasks: new TaskService(database.db, () => new Date(), {
      executorMode: 'agent',
      agentConfiguration: configuration,
      researchPolicy: configuration.research.policy,
      executionLimits: readAgentExecutionLimits({}),
    }),
    agentRuns: {
      serviceToken: token,
      checkRun: (body) => executor.checkRun(body),
      researchCallback: async (body) => {
        callbacks.push(structuredClone(body));
        return research.handle(body);
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
    env: { DEEPSEEK_API_KEY: 'offline-never-sent', RESEARCH_WEB_ROOT: directory },
    researchWeb: {
      checkPublicAddress: async () => {},
      readOriginal: async (url) => ({
        finalUrl: url,
        redirects: [],
        text: bodyText,
        truncated: false,
        responseSha256: hash(bodyText),
        links: ['https://example.com/docs/'],
        mediaKind: 'text',
      }),
    },
    acquireHotList: async () => {
      hotCalls++;
      return parseGithubHot({
        provider: 'xxapi',
        requestUrl: GITHUB_HOT_API_URL,
        fetchedAt: new Date().toISOString(),
        data: {
          code: 200,
          data: [{ title: 'fixture', desc: '固定候选', url: 'https://github.com/example/fixture' }],
        },
      });
    },
    run: (context, options) =>
      runSupervisor(context, {
        ...options,
        query: ({ options: sdkOptions }) => {
          const stream = (async function* () {
            try {
              yield* sdk(context, options, sdkOptions);
            } catch (error) {
              rejections.push(error);
              throw error;
            }
          })();
          return Object.assign(stream, { close() {} });
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
    { pollMs: 10, heartbeatMs: 50, leaseMs: 2000 },
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'idempotency-key': randomUUID() },
    payload: { login: 'research.runner', password: 'offline-research-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  identity = {
    cookie: login.headers['set-cookie'].split(';')[0],
    'x-csrf-token': login.json().data.csrfToken,
  };
  executor.start();
});
after(async () => {
  await close();
  if (database) await database.close();
  if (client) await client.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${roleName}"`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function api(path, body, status = body ? 202 : 200) {
  const response = await app.inject({
    method: body ? 'POST' : 'GET',
    url: `/api/v1${path}`,
    headers: { origin, ...identity, ...(body ? { 'idempotency-key': randomUUID() } : {}) },
    ...(body ? { payload: body } : {}),
  });
  assert.equal(response.statusCode, status, response.body);
  return response.json().data;
}
async function wait(taskId, status) {
  for (let i = 0; i < 300; i++) {
    const detail = await api(`/tasks/${taskId}`);
    if (detail.execution === status) return detail;
    if (detail.execution === 'failed' && status !== 'failed')
      assert.fail(
        `${detail.currentAttempt.error?.code}: ${rejections.map((e) => e.message).join(';')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting ${status}`);
}
async function select() {
  let detail = await api(
    '/tasks',
    { title: '离线研究任务', originalRequest: '研究所选项目，不发布。', referenceInputs: [] },
    201,
  );
  await api(`/tasks/${detail.task.id}/attempts`, { expectedRevision: detail.task.revision });
  detail = await wait(detail.task.id, 'awaiting_selection');
  const candidate = detail.agentExecution.hotList.items[0];
  await api(`/tasks/${detail.task.id}/project-selection`, {
    expectedRevision: detail.task.revision,
    attemptId: detail.task.currentAttemptId,
    hotListSnapshotId: detail.agentExecution.hotList.id,
    candidateId: candidate.id,
    authorizeResearch: true,
  });
  return detail.task.id;
}

test('选题后真实后端/Agent/Supervisor/Research hooks 闭环，报告与费用入库并等待创作', async () => {
  const id = await select(),
    detail = await wait(id, 'awaiting_content');
  assert.equal(hotCalls, 1);
  assert.equal(researchDispatches, 1);
  assert.equal(detail.currentAttempt.finishedAt, null);
  assert.equal(detail.workLock.ownerId, detail.task.currentAttemptId);
  const [attempt] = (
    await client.query('SELECT * FROM execution_attempts WHERE id=$1', [
      detail.task.currentAttemptId,
    ])
  ).rows;
  assert.equal(attempt.executor_id, null);
  assert.equal(attempt.active_since, null);
  const list = await api(`/tasks/${id}/research-results`);
  assert.equal(list.items.length, 1);
  const report = validateResearchResult(
    await api(`/tasks/${id}/research-results/${list.items[0].id}`),
  );
  assert.equal(report.report.sections.length, 6);
  assert.equal(report.version, 1);
  assert.equal(report.report.status, 'completed');
  const [authorization] = (
    await client.query('SELECT * FROM research_authorizations WHERE task_id=$1', [id])
  ).rows;
  assert.ok(authorization.consumed_at);
  assert.equal(authorization.consumed_by_step_id, report.execution.stepId);
  const [budget] = (
    await client.query('SELECT * FROM task_execution_budgets WHERE task_id=$1', [id])
  ).rows;
  // Two SDK sessions, each model usage 100 input/50 output, plus 4 admitted web calls.
  assert.equal(Number(budget.charged_cost_micros_cny), 21200);
  assert.equal(budget.calls, 3);
  assert.equal(deniedFetches, 1);
});
test('核心缺口等待补资料，无新资料也可补查；官网范围每轮重置，历史报告完整保留', async () => {
  scenario = 'partial';
  const id = await select();
  let detail = await wait(id, 'awaiting_materials');
  const first = (await api(`/tasks/${id}/research-results`)).items[0];
  const submit = async (grants) =>
    api(`/tasks/${id}/research-supplements`, {
      expectedRevision: detail.task.revision,
      attemptId: detail.task.currentAttemptId,
      baseResultId: detail.agentExecution.research.latestReport.id,
      questionIds: ['question-feature'],
      gapIds: detail.execution === 'awaiting_materials' ? ['gap-core'] : [],
      materials: [],
      confirmExistingMaterials: [],
      officialSiteGrants: grants,
      authorizeResearch: true,
    });
  const command = await submit([{ origin: 'https://example.com', pathPrefix: '/docs/' }]);
  detail = await wait(id, 'awaiting_content');
  assert.equal(researchDispatches, 2);
  assert.equal(hotCalls, 1);
  const second = await api(
    `/tasks/${id}/research-results/${detail.agentExecution.research.latestReport.id}`,
  );
  assert.equal(second.version, 2);
  assert.equal(second.parentResultId, first.id);
  assert.equal(
    second.report.changes.some((c) => c.kind === 'gap_resolved'),
    true,
  );
  const submission = await api(`/tasks/${id}/research-submissions/${command.submissionId}`);
  assert.equal(submission.records.length, 0);
  await submit([]);
  detail = await wait(id, 'awaiting_content');
  const latest = await api(
    `/tasks/${id}/research-results/${detail.agentExecution.research.latestReport.id}`,
  );
  assert.equal(latest.version, 3);
  assert.equal(deniedFetches, 2);
  assert.equal(researchDispatches, 3);
  const old = await api(`/tasks/${id}/research-results/${first.id}`);
  assert.equal(old.report.status, 'partial');
});
test('澄清保留未消耗授权，同 attempt 答复后才分派一次研究', async () => {
  scenario = 'clarify';
  const id = await select();
  let detail = await wait(id, 'awaiting_clarification');
  const auth = (await client.query('SELECT * FROM research_authorizations WHERE task_id=$1', [id]))
    .rows[0];
  assert.equal(auth.consumed_at, null);
  assert.equal(researchDispatches, 0);
  await api(`/tasks/${id}/clarifications`, {
    expectedRevision: detail.task.revision,
    attemptId: detail.task.currentAttemptId,
    answers: detail.task.clarifications
      .filter((q) => q.answer === null)
      .map((q) => ({ questionId: q.questionId, answer: '面向开源用户' })),
  });
  detail = await wait(id, 'awaiting_content');
  assert.equal(researchDispatches, 1);
  assert.equal(hotCalls, 1);
  assert.equal(detail.task.currentAttemptId, auth.attempt_id);
});
test('报告格式只在同一子会话有限纠正，纠正期间禁止工具；失败不采用报告或重开研究', async () => {
  scenario = 'repair';
  let id = await select();
  await wait(id, 'awaiting_content');
  assert.equal(corrections, 1);
  assert.equal(researchDispatches, 1);
  assert.equal(sdkCalls, 2);
  scenario = 'invalid';
  id = await select();
  await wait(id, 'failed');
  assert.equal((await api(`/tasks/${id}/research-results`)).items.length, 0);
  assert.equal(researchDispatches, 2);
  const auth = (
    await client.query('SELECT consumed_at FROM research_authorizations WHERE task_id=$1', [id])
  ).rows[0];
  assert.ok(auth.consumed_at);
});
test('重复/伪造私有回调不产生第二次执行，停止隔离旧 token 与迟到结果', async () => {
  scenario = 'held';
  const id = await select();
  for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(held, true);
  const claim = callbacks.find((c) => c.operation === 'claim');
  assert.ok(claim);
  const send = async (value, bearer = token) =>
    app.inject({
      method: 'POST',
      url: '/internal/v1/research/events',
      headers: { authorization: `Bearer ${bearer}` },
      payload: value,
    });
  const replay = await send(claim);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().execute, false);
  assert.equal(replay.json().replayed, true);
  assert.equal((await send({ ...claim, dispatchToolUseId: 'other' })).statusCode, 409);
  assert.equal((await send(claim, 'wrong')).statusCode, 401);
  const detail = await api(`/tasks/${id}`);
  await api(`/tasks/${id}/attempts/${detail.task.currentAttemptId}/stop`, {
    expectedRevision: detail.task.revision,
    reason: '人工停止',
  });
  await wait(id, 'cancelled');
  for (let i = 0; i < 200 && !observedSignal.aborted; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(observedSignal.aborted, true);
  const start = callbacks.find((c) => c.operation === 'start');
  assert.equal((await send(start)).statusCode, 409);
  assert.equal((await api(`/tasks/${id}/research-results`)).items.length, 0);
  assert.equal(researchDispatches, 1);
});
test('报告采用后 Supervisor 失败保留研究历史，新 attempt 从版本 1 开始且费用累计', async () => {
  scenario = 'supervisor-fail';
  const id = await select();
  let detail = await wait(id, 'failed');
  const oldAttempt = detail.task.currentAttemptId;
  assert.equal((await api(`/tasks/${id}/research-results`)).items.length, 1);
  const budgetBefore = Number(
    (
      await client.query(
        'SELECT charged_cost_micros_cny FROM task_execution_budgets WHERE task_id=$1',
        [id],
      )
    ).rows[0].charged_cost_micros_cny,
  );
  // Unknown SDK usage conservatively retains its large reservation; give the test an explicit small reserve for the initial run.
  assert.ok(budgetBefore > 0);
  scenario = 'ready';
  await api(`/tasks/${id}/research-attempt-retries`, {
    expectedRevision: detail.task.revision,
    previousAttemptId: oldAttempt,
    reason: '重新执行',
    authorizeResearch: true,
  });
  detail = await wait(id, 'awaiting_content');
  assert.notEqual(detail.task.currentAttemptId, oldAttempt);
  const result = await api(
    `/tasks/${id}/research-results/${detail.agentExecution.research.latestReport.id}`,
  );
  assert.equal(result.version, 1);
  assert.equal(result.parentResultId, null);
  assert.equal(hotCalls, 1);
  assert.equal(
    (await api(`/tasks/${id}/research-results?attemptId=${oldAttempt}`)).items.length,
    1,
  );
  assert.ok(
    Number(
      (
        await client.query(
          'SELECT charged_cost_micros_cny FROM task_execution_budgets WHERE task_id=$1',
          [id],
        )
      ).rows[0].charged_cost_micros_cny,
    ) > budgetBefore,
  );
});

test('报告最终写入失败时整笔采用事务回滚，授权不恢复且不自动重跑', async () => {
  await client.query(
    `CREATE FUNCTION reject_offline_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='research' AND NEW.validated_output IS NOT NULL THEN RAISE EXCEPTION 'offline report failure'; END IF; RETURN NEW; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_offline_report BEFORE UPDATE ON execution_steps FOR EACH ROW EXECUTE FUNCTION reject_offline_report()`,
  );
  try {
    const id = await select();
    await wait(id, 'failed');
    assert.equal((await api(`/tasks/${id}/research-results`)).items.length, 0);
    const auth = (
      await client.query('SELECT consumed_at FROM research_authorizations WHERE task_id=$1', [id])
    ).rows[0];
    assert.ok(auth.consumed_at);
    assert.equal(researchDispatches, 1);
    const events = (
      await client.query(
        "SELECT action FROM audit_events WHERE task_id=$1 AND action='research.result_accepted'",
        [id],
      )
    ).rows;
    assert.equal(events.length, 0);
  } finally {
    await client.query('DROP TRIGGER reject_offline_report ON execution_steps');
    await client.query('DROP FUNCTION reject_offline_report()');
  }
});
