import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentClient, AgentServiceError } from './agent-client.js';
import { readAgentConfiguration, readAgentExecutionLimits } from './agent-execution-config.js';

test('私有失败诊断通过严格契约传递，未知原始模型字段不接受', async () => {
  const diagnostic = {
    hasStructuredOutput: false,
    outputType: 'undefined',
    errorType: 'missing_structured_output',
    issues: [],
  };
  const client = new AgentClient({
    baseUrl: 'http://127.0.0.1:3002',
    serviceToken: 'b'.repeat(64),
    fetch: async () =>
      Response.json({ error: { code: 'SUPERVISOR_OUTPUT_INVALID', diagnostic } }, { status: 502 }),
  });
  await assert.rejects(
    client.acquireHotList(
      {
        runId: randomUUID(),
        lease: { executorId: randomUUID(), claimToken: randomUUID(), generation: 1 },
        execution: {
          taskId: randomUUID(),
          attemptId: randomUUID(),
          stepId: randomUUID(),
          inputSnapshotId: randomUUID(),
        },
      },
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentServiceError);
      assert.deepEqual(error.diagnostic, diagnostic);
      return true;
    },
  );
});

test('Agent 客户端禁止跳转和自动重试，安全错误不泄露服务凭据', async () => {
  let calls = 0;
  const token = 'b'.repeat(64);
  const client = new AgentClient({
    baseUrl: 'http://127.0.0.1:3002',
    serviceToken: token,
    fetch: async (_url, options) => {
      calls++;
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
      throw new Error(`private ${token}`);
    },
  });
  await assert.rejects(
    client.acquireHotList(
      {
        runId: randomUUID(),
        lease: { executorId: randomUUID(), claimToken: randomUUID(), generation: 1 },
        execution: {
          taskId: randomUUID(),
          attemptId: randomUUID(),
          stepId: randomUUID(),
          inputSnapshotId: randomUUID(),
        },
      },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof AgentServiceError &&
      error.code === 'AGENT_NETWORK_ERROR' &&
      !error.message.includes(token),
  );
  assert.equal(calls, 1);
  assert.throws(() => new AgentClient({ baseUrl: 'http://remote.test', serviceToken: token }));
});

test('真实执行采用已确认的时间和纠正次数，缺少计价或 SDK 预算禁止启用', () => {
  const limits = readAgentExecutionLimits({
    TASK_CALL_TIMEOUT_MS: '120000',
    TASK_TECHNICAL_MAX_RETRIES: '2',
  });
  assert.equal(limits.callTimeoutMs, 900000);
  assert.equal(limits.stepTimeoutMs, 900000);
  assert.equal(limits.attemptTimeoutMs, 1200000);
  assert.equal(limits.maxRetries, 0);
  assert.throws(() => readAgentConfiguration({}));
  const configuration = readAgentConfiguration({
    TASK_MODEL_PRICING_VERSION: 'offline-v1',
    TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION: '1000000',
    TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '2000000',
    AGENT_SESSION_MAX_BUDGET_USD: '0.1',
  });
  assert.equal(configuration.supervisor.maxOutputAttempts, 3); // initial + two corrections
});

test('Research 显式启用需要网页计价且限制 SDK 预算，默认保持关闭', () => {
  const env = {
    TASK_MODEL_PRICING_VERSION: 'peak-v1',
    TASK_MODEL_INPUT_MICROS_CNY_PER_MILLION: '2000000',
    TASK_MODEL_OUTPUT_MICROS_CNY_PER_MILLION: '8000000',
    AGENT_SESSION_MAX_BUDGET_USD: '0.10',
  };
  assert.equal(readAgentConfiguration(env).research, undefined);
  assert.throws(() => readAgentConfiguration({ ...env, TASK_RESEARCH_ENABLED: 'true' }));
  assert.throws(() =>
    readAgentConfiguration({
      ...env,
      TASK_RESEARCH_ENABLED: 'true',
      TASK_WEB_REQUEST_MICROS_CNY: '5000',
      AGENT_SESSION_MAX_BUDGET_USD: '0.11',
    }),
  );
  const config = readAgentConfiguration({
    ...env,
    TASK_RESEARCH_ENABLED: 'true',
    TASK_WEB_REQUEST_MICROS_CNY: '5000',
  });
  assert.equal(config.research?.webRequestMicrosCny, 5000);
  assert.equal(config.research?.policy.skills[0]?.requiredSections.length, 6);
  assert.equal(config.research?.policy.limits.maxVideoCalls, 0);
});
