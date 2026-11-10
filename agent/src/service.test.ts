import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentRunResponseSchema,
  SUPERVISOR_PROMPT_VERSION,
  SUPERVISOR_TOOL_POLICY_VERSION,
  type AgentRunRequest,
} from '@multi-agent-ops/shared';
import { createAgentService } from './service.js';
import { runSupervisor } from './agents/supervisor/runtime.js';
import {
  parseGithubHot,
  GITHUB_HOT_API_URL,
  type GithubHotSnapshot,
} from './integrations/xxapi/github-hot.js';

const token = 'a'.repeat(64);
function request(): AgentRunRequest {
  const hotList = parseGithubHot({
    provider: 'xxapi',
    requestUrl: GITHUB_HOT_API_URL,
    fetchedAt: new Date().toISOString(),
    data: {
      code: 200,
      data: [{ title: 'demo', desc: '说明', url: 'https://github.com/example/demo' }],
    },
  }).list;
  return {
    protocolVersion: 1,
    runId: randomUUID(),
    lease: { executorId: randomUUID(), claimToken: randomUUID(), generation: 1 },
    context: {
      schemaVersion: '2.0',
      execution: {
        taskId: randomUUID(),
        attemptId: randomUUID(),
        stepId: randomUUID(),
        inputSnapshotId: randomUUID(),
      },
      trigger: 'hot_list_loaded',
      hotList,
      selectedProject: null,
      task: { title: 'demo', originalRequest: '介绍一个 GitHub 项目', referenceInputs: [] },
      clarifications: [],
      accountContext: {
        accountId: null,
        description: null,
        defaultAudience: null,
        defaultTone: null,
        prohibitions: [],
      },
      memoryContext: [],
      researchContext: {
        authorizationId: null,
        authorizationUsed: false,
        acceptedResultIds: [],
        inputs: null,
      },
      runtimePolicy: {
        stage: 'D9',
        allowedSubagents: [],
        configVersion: 1,
        promptVersion: SUPERVISOR_PROMPT_VERSION,
        toolPolicyVersion: SUPERVISOR_TOOL_POLICY_VERSION,
      },
      contextSelection: { includedRefs: [], omitted: [] },
    },
    limits: {
      timeoutMs: 1000,
      maxTurns: 3,
      maxBudgetUsd: 0.1,
      maxOutputTokens: 100,
      maxOutputAttempts: 3,
    },
    maxTotalTokens: 1000,
    acceptedResearchResults: [],
  };
}
async function listen(service: ReturnType<typeof createAgentService>) {
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
}

test('独立 HTTP 服务实际调用 runSupervisor；拒绝未认证、失去执行权和重复请求', async () => {
  let sdkCalls = 0;
  let valid = true;
  const service = createAgentService({
    serviceToken: token,
    backendBaseUrl: 'http://127.0.0.1:3001',
    env: { DEEPSEEK_API_KEY: 'offline' },
    checkRun: async () => {
      if (!valid) throw new Error('revoked');
    },
    run: (context, options) =>
      runSupervisor(context, {
        ...options,
        query: () => {
          sdkCalls++;
          const input = context as AgentRunRequest['context'];
          const session = (async function* () {
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 'offline-session',
              num_turns: 1,
              total_cost_usd: 0,
              modelUsage: {},
              structured_output: {
                decision: 'awaiting_selection',
                hotListSnapshotId: input.hotList!.id,
                summary: '等待用户选择',
                basisRefs: [input.hotList!.id],
                defaultsUsed: [],
                warnings: [],
              },
            } as SDKMessage;
          })();
          return Object.assign(session, { close() {} });
        },
      }),
  });
  const base = await listen(service);
  const invoke = (body: AgentRunRequest, authorization = `Bearer ${token}`) =>
    fetch(`${base}/internal/v1/supervisor/runs`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const body = request();
    assert.equal((await invoke(body, 'Bearer invalid')).status, 401);
    assert.equal(sdkCalls, 0);
    const response = await invoke(body);
    assert.equal(response.status, 200);
    const output = AgentRunResponseSchema.parse(await response.json());
    assert.equal(output.result.output.decision, 'awaiting_selection');
    assert.equal(sdkCalls, 1);
    assert.equal((await invoke(body)).status, 409);
    assert.equal(sdkCalls, 1);
    valid = false;
    assert.equal((await invoke(request())).status, 502);
    assert.equal(sdkCalls, 1);
  } finally {
    await service.close();
  }
});

test('客户端断开会取消服务执行；已接收的运行不会再次调用模型', async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled!: () => void;
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const service = createAgentService({
    serviceToken: token,
    backendBaseUrl: 'http://127.0.0.1:3001',
    checkRun: async () => {},
    run: async (_context, options) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => {
            cancelled();
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      throw new Error('unreachable');
    },
  });
  const base = await listen(service);
  try {
    const controller = new AbortController();
    const call = fetch(`${base}/internal/v1/supervisor/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request()),
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    await assert.rejects(call);
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cancel timeout')), 2000);
        timer.unref();
      }),
    ]);
  } finally {
    await service.close();
  }
});

test('榜单解析保留顺序和空榜单，拒绝业务失败、伪链接、重复和无效条目', () => {
  const snapshot: GithubHotSnapshot = {
    provider: 'xxapi',
    requestUrl: GITHUB_HOT_API_URL,
    fetchedAt: new Date().toISOString(),
    data: { code: 200, data: [] },
  };
  assert.equal(parseGithubHot(snapshot).list.items.length, 0);
  for (const data of [
    1,
    { code: 401, data: [] },
    { code: 200, data: [{ title: '', desc: '', url: 'https://github.com/a/b' }] },
    { code: 200, data: [{ title: 'a', desc: '', url: 'https://github.com.evil.test/a/b' }] },
    {
      code: 200,
      data: [
        { title: 'a', desc: '', url: 'https://github.com/a/b' },
        { title: 'b', desc: '', url: 'https://github.com/A/B/' },
      ],
    },
  ])
    assert.throws(() => parseGithubHot({ ...snapshot, data }));
});
