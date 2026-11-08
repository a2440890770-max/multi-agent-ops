import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import type {
  HookInput,
  Options,
  SDKMessage,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContentContextSchema, ContentOutputSchema } from '@multi-agent-ops/shared';
import type { ContentContext, ContentOutput } from '@multi-agent-ops/shared';
import { CONTENT_SKILL, CONTENT_SKILL_TOOL, ContentError, runContent } from './index.js';
import type { ContentQuery } from './index.js';
import { loadContentSkill } from './agents/content/skill.js';
import { parseContentContext, validateContentOutput } from './agents/content/validation.js';
import { z } from 'zod';

const context: ContentContext = {
  schemaVersion: '1.0',
  execution: {
    taskId: 'task-1',
    attemptId: 'attempt-1',
    stepId: 'content-1',
    inputSnapshotId: 'input-1',
    epoch: 1,
  },
  controlMode: 'automatic',
  project: {
    id: 'project-1',
    selectionId: 'selection-1',
    repository: 'example/tool',
    url: 'https://github.com/example/tool',
  },
  requirements: {
    revision: 1,
    objective: '介绍项目的用途',
    audience: '开发者',
    tone: '清晰克制',
    constraints: [],
    prohibitions: [],
  },
  format: { pageCount: 1, titleMaxChars: 30, pageBodyMaxChars: 100 },
  research: {
    id: 'research-1',
    projectId: 'project-1',
    sources: [
      {
        id: 'source-1',
        url: 'https://github.com/example/tool',
        label: 'README',
        locator: '功能章节',
        excerpt: '支持整理笔记。',
      },
    ],
    facts: [
      {
        id: 'fact-1',
        statement: '作者介绍：支持整理笔记。',
        kind: 'attributed_opinion',
        sourceIds: ['source-1'],
        requiredQualifier: '作者介绍',
      },
    ],
    gaps: [],
    exclusions: ['不讨论性能提升'],
  },
  usableFactIds: ['fact-1'],
  skill: { id: CONTENT_SKILL.id, version: CONTENT_SKILL.version },
  revision: { mode: 'initial', autoRevisionCount: 0 },
};
const draft: Extract<ContentOutput, { decision: 'draft' }> = {
  decision: 'draft',
  summary: '仅使用已接受的作者说明。',
  plan: {
    title: '一个笔记整理工具',
    cover: {
      headline: '整理笔记',
      subtitle: null,
      visualBrief: '以便签组合表达整理思路，非项目截图。',
    },
    pages: [
      {
        key: 'overview',
        heading: '项目用途',
        body: '作者介绍：支持整理笔记。',
        visualBrief: '用卡片表现分类，人工制作。',
      },
    ],
    caption: '看看这个项目。',
    hashtags: ['开源项目'],
    projectUrl: context.project.url,
    productionNotes: ['制作前核对素材许可。'],
  },
  claimRefs: [
    {
      fieldPath: 'pages.overview.body',
      claim: '作者介绍：支持整理笔记。',
      kind: 'attributed_opinion',
      factIds: ['fact-1'],
      sourceIds: ['source-1'],
    },
  ],
  changeResponses: [],
  warnings: [],
  defaultsUsed: [],
};
const limits = {
  timeoutMs: 1000,
  maxTurns: 8,
  maxBudgetUsd: 0.1,
  maxOutputTokens: 4096,
  maxOutputAttempts: 2,
};
const env = { DEEPSEEK_API_KEY: 'offline-test-key' };
const code = (expected: string) => (error: unknown) =>
  error instanceof ContentError && error.code === expected;
const message = (value: unknown) => value as SDKMessage;
const result = (output: unknown) =>
  message({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: output,
    num_turns: 2,
    modelUsage: {},
    total_cost_usd: 0.01,
  });

async function pre(options: Options, name: string, input: unknown): Promise<SyncHookJSONOutput> {
  const callback = options.hooks!.PreToolUse![0]!.hooks[0]!;
  return (await callback(
    {
      hook_event_name: 'PreToolUse',
      tool_name: name,
      tool_input: input,
      tool_use_id: 'call-1',
      session_id: 'session-1',
      cwd: options.cwd,
    } as HookInput,
    'call-1',
    { signal: options.abortController!.signal },
  )) as SyncHookJSONOutput;
}

/** Exercise the real in-process MCP handler without a model, network, CLI or database. */
async function readSkill(options: Options) {
  const server = options.mcpServers!.content!;
  assert.equal(server.type, 'sdk');
  if (server.type !== 'sdk') assert.fail();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'offline-content-test', version: '1' });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ['read_content_skill'],
    );
    const output = await client.callTool({ name: 'read_content_skill', arguments: context.skill });
    assert.notEqual(output.isError, true);
    return output;
  } finally {
    await client.close();
  }
}

function sdk(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const state = { closed: false, calls: 0, directory: undefined as string | undefined };
  const query: ContentQuery = ({ options, prompt }) => {
    state.calls += 1;
    state.directory = options.cwd;
    const stream = (async function* () {
      assert.notEqual(typeof prompt, 'string');
      if (typeof prompt === 'string') assert.fail();
      for await (const input of prompt) {
        assert.equal(input.client_composed, true);
        assert.match(String(input.message.content), /"taskId":"task-1"/);
      }
      yield* script(options);
    })();
    return Object.assign(stream, {
      close() {
        state.closed = true;
      },
    });
  };
  return { query, state };
}

test('Content 契约严格拒绝多余业务权限字段，且可生成 SDK JSON Schema', () => {
  assert.equal(ContentContextSchema.safeParse(context).success, true);
  assert.equal(ContentOutputSchema.safeParse({ ...draft, approved: true }).success, false);
  assert.equal(ContentOutputSchema.safeParse({ ...draft, scores: [100] }).success, false);
  assert.doesNotThrow(() => z.toJSONSchema(ContentOutputSchema, { target: 'draft-7' }));
});

test('Skill 注册表校验固定版本与摘要，不能通过路径选择任意文件', async () => {
  const skill = await loadContentSkill(context.skill);
  assert.equal(skill.sha256, CONTENT_SKILL.sha256);
  assert.match(skill.instructions, /name: github-project-content/);
  await assert.rejects(
    loadContentSkill({ id: '../../.env', version: '1' }),
    code('CONTENT_SKILL_NOT_CONFIGURED'),
  );
});

test('合法草案必须保留证据类型、限定语和引用，拒绝改项目与未知字段定位', () => {
  assert.deepEqual(validateContentOutput(draft, context), draft);
  for (const [change, expected] of [
    [{ kind: 'fact' }, 'CONTENT_CLAIM_KIND_INVALID'],
    [{ claim: '支持整理笔记。' }, 'CONTENT_QUALIFIER_REQUIRED'],
    [{ factIds: ['made-up'] }, 'CONTENT_REFERENCE_INVALID'],
    [{ sourceIds: ['other-source'] }, 'CONTENT_REFERENCE_INVALID'],
    [{ fieldPath: '__proto__.body' }, 'CONTENT_CLAIM_INVALID'],
  ] as const) {
    assert.throws(
      () =>
        validateContentOutput(
          { ...draft, claimRefs: [{ ...draft.claimRefs[0], ...change }] },
          context,
        ),
      code(expected),
    );
  }
  assert.throws(
    () =>
      validateContentOutput(
        { ...draft, plan: { ...draft.plan, projectUrl: 'https://example.com/other' } },
        context,
      ),
    code('CONTENT_PROJECT_MISMATCH'),
  );
});

test('核心缺口只能补资料；非核心缺口和未知缺口不能伪装为已完成', () => {
  const ctx = structuredClone(context);
  ctx.research.gaps = [{ id: 'gap-1', severity: 'core', description: '核心用途缺少直接证据' }];
  assert.throws(() => validateContentOutput(draft, ctx), code('CONTENT_CORE_GAP'));
  const waiting = {
    decision: 'needs_materials',
    summary: '等待核心材料',
    gapIds: ['gap-1'],
    requests: ['请提供用途说明。'],
  };
  assert.deepEqual(validateContentOutput(waiting, ctx), waiting);
  assert.throws(
    () => validateContentOutput({ ...waiting, gapIds: ['invented'] }, ctx),
    code('CONTENT_GAP_INVALID'),
  );
});

test('新发现的证据或要求问题可交回 Supervisor，不编造研究缺口 ID', () => {
  const blocked = {
    decision: 'blocked',
    code: 'new_evidence_gap',
    summary: '现有证据无法支持所要求的性能对比。',
    requests: ['请提供对比测试材料，或移除性能对比要求。'],
  };
  assert.deepEqual(validateContentOutput(blocked, context), blocked);
  assert.equal(ContentOutputSchema.safeParse({ ...blocked, code: 'auto_publish' }).success, false);
});

test('人工控制、跨项目研究、无效引用与第四轮修改在调用前被拒绝', () => {
  assert.throws(
    () => parseContentContext({ ...context, controlMode: 'human' }),
    code('CONTENT_HUMAN_CONTROL'),
  );
  assert.throws(
    () =>
      parseContentContext({ ...context, research: { ...context.research, projectId: 'other' } }),
    code('CONTENT_PROJECT_MISMATCH'),
  );
  assert.throws(
    () => parseContentContext({ ...context, usableFactIds: ['other'] }),
    code('CONTENT_REFERENCE_INVALID'),
  );
  assert.throws(
    () => parseContentContext({ ...context, revision: { mode: 'initial', autoRevisionCount: 4 } }),
    code('CONTENT_CONTEXT_INVALID'),
  );
});

test('修订必须匹配父版本并逐项回应意见，不宣称未解决项已通过', () => {
  const ctx: ContentContext = {
    ...context,
    revision: {
      mode: 'revise',
      autoRevisionCount: 3,
      roundId: 'round-3',
      parentVersionId: 'v1',
      parentPlan: draft.plan,
      reviewId: 'review-1',
      reviewedVersionId: 'v1',
      issues: [
        {
          id: 'issue-1',
          kind: 'subjective',
          fieldPath: 'title',
          message: '标题需要更具体',
          suggestion: '突出用途',
        },
      ],
    },
  };
  assert.throws(() => validateContentOutput(draft, ctx), code('CONTENT_CHANGE_INVALID'));
  const revised = {
    ...draft,
    changeResponses: [
      {
        issueId: 'issue-1',
        action: 'unresolved',
        fieldPaths: ['title'],
        reason: '需要人工确认标题偏好。',
      },
    ],
  };
  assert.equal(validateContentOutput(revised, ctx).decision, 'draft');
  assert.throws(
    () =>
      parseContentContext({ ...ctx, revision: { ...ctx.revision, reviewedVersionId: 'other' } }),
    code('CONTENT_REVIEW_MISMATCH'),
  );
  assert.throws(
    () => parseContentContext({ ...ctx, revision: { ...ctx.revision, autoRevisionCount: 4 } }),
    code('CONTENT_CONTEXT_INVALID'),
  );
});

test('配置长度按 Unicode 字符计，页数和重复 key 受到校验', () => {
  assert.throws(
    () => validateContentOutput(draft, { ...context, format: { ...context.format, pageCount: 2 } }),
    code('CONTENT_FORMAT_INVALID'),
  );
  assert.throws(
    () =>
      validateContentOutput(
        { ...draft, plan: { ...draft.plan, pages: [...draft.plan.pages, ...draft.plan.pages] } },
        context,
      ),
    code('CONTENT_PAGE_INVALID'),
  );
  assert.throws(
    () =>
      validateContentOutput(draft, { ...context, format: { ...context.format, titleMaxChars: 1 } }),
    code('CONTENT_FORMAT_INVALID'),
  );
});

test('独立 Content 调用真实 MCP 工具后交付结果，关闭会话并清理临时目录', async () => {
  const fake = sdk(async function* (options) {
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.allowedTools, [CONTENT_SKILL_TOOL, 'StructuredOutput']);
    assert.deepEqual(options.settingSources, []);
    const read = await pre(options, CONTENT_SKILL_TOOL, context.skill);
    assert.equal(read.hookSpecificOutput?.hookEventName, 'PreToolUse');
    await readSkill(options);
    const submit = await pre(options, 'StructuredOutput', draft);
    assert.equal(
      submit.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
        submit.hookSpecificOutput.permissionDecision,
      'allow',
    );
    yield result(draft);
  });
  const response = await runContent(context, {
    limits,
    env,
    query: fake.query,
    onEvent: () => {
      throw new Error('observer failure');
    },
  });
  assert.deepEqual(response.output, draft);
  assert.equal(response.metadata.skill.sha256, CONTENT_SKILL.sha256);
  assert.equal(response.metadata.outputAttempts, 1);
  assert.ok(response.metadata.observationErrors >= 2);
  assert.equal(fake.state.calls, 1);
  assert.equal(fake.state.closed, true);
  await assert.rejects(access(fake.state.directory!));
});

test('未实际读取 Skill 的成功结果被拒绝，不信任模型自述', async () => {
  const fake = sdk(async function* () {
    yield result(draft);
  });
  await assert.rejects(
    runContent(context, { limits, env, query: fake.query }),
    code('CONTENT_SKILL_NOT_READ'),
  );
});

test('越权工具与 Skill 参数立刻停止，不能在同会话继续提交', async () => {
  for (const [name, input, expected] of [
    ['Bash', { command: 'echo no' }, 'CONTENT_TOOL_DENIED'],
    ['WebSearch', { query: 'extra research' }, 'CONTENT_TOOL_DENIED'],
    [CONTENT_SKILL_TOOL, { ...context.skill, path: '.env' }, 'CONTENT_SKILL_TOOL_DENIED'],
  ] as const) {
    const fake = sdk(async function* (options) {
      await pre(options, name, input);
      yield result(draft);
    });
    await assert.rejects(runContent(context, { limits, env, query: fake.query }), code(expected));
  }
});

test('错误格式只做有限纠正，不重启模型、不增加业务修订轮次', async () => {
  const fake = sdk(async function* (options) {
    await readSkill(options);
    for (let i = 0; i < 3; i++) await pre(options, 'StructuredOutput', { decision: 'approved' });
    yield result(draft);
  });
  await assert.rejects(
    runContent(context, { limits, env, query: fake.query }),
    code('CONTENT_OUTPUT_ATTEMPTS_EXHAUSTED'),
  );
  assert.equal(fake.state.calls, 1);
  assert.deepEqual(context.revision, { mode: 'initial', autoRevisionCount: 0 });
});

test('人工接管的取消信号隔离迟到结果；未响应的模型有调用时限', async () => {
  const controller = new AbortController();
  const fake = sdk(async function* () {
    controller.abort();
    yield result(draft);
  });
  await assert.rejects(
    runContent(context, { limits, env, signal: controller.signal, query: fake.query }),
    code('CONTENT_CANCELLED'),
  );
  assert.equal(fake.state.closed, true);
  const hanging = sdk(async function* () {
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield result(draft);
  });
  await assert.rejects(
    runContent(context, { limits: { ...limits, timeoutMs: 10 }, env, query: hanging.query }),
    code('CONTENT_TIMEOUT'),
  );
  assert.equal(hanging.state.closed, true);
});

test('缺少模型配置或调用前已取消时不调用 SDK', async () => {
  const fake = sdk(async function* () {
    yield result(draft);
  });
  await assert.rejects(
    runContent(context, { limits, env: {}, query: fake.query }),
    code('CONTENT_MODEL_CONFIGURATION_INVALID'),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runContent(context, { limits, env, query: fake.query, signal: controller.signal }),
    code('CONTENT_CANCELLED'),
  );
  assert.equal(fake.state.calls, 0);
});

test('事件回调中的接管也会停止调用，完成通知期间取消不能返回候选', async () => {
  for (const kind of ['started', 'completed'] as const) {
    const controller = new AbortController();
    const fake = sdk(async function* (options) {
      await readSkill(options);
      yield result(draft);
    });
    await assert.rejects(
      runContent(context, {
        limits,
        env,
        query: fake.query,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === kind) controller.abort();
        },
      }),
      code('CONTENT_CANCELLED'),
    );
    assert.equal(fake.state.calls, kind === 'started' ? 0 : 1);
  }
});

test('超时后的断连清理错误不会覆盖原始错误码，临时目录仍被清理', async () => {
  const fake = sdk(async function* () {
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield result(draft);
  });
  const query: ContentQuery = (request) => {
    const session = fake.query(request);
    return Object.assign(session, {
      close() {
        throw new Error('raw cleanup details');
      },
    });
  };
  await assert.rejects(
    runContent(context, { limits: { ...limits, timeoutMs: 10 }, env, query }),
    code('CONTENT_TIMEOUT'),
  );
  await assert.rejects(access(fake.state.directory!));
});

test('SDK 返回预算终态后即使传输抛错，也保留预算原因', async () => {
  const fake = sdk(async function* () {
    yield message({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      num_turns: 2,
    });
    throw new Error('later transport error');
  });
  await assert.rejects(
    runContent(context, { limits, env, query: fake.query }),
    code('CONTENT_SDK_BUDGET_EXCEEDED'),
  );
});
