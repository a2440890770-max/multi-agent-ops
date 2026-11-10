import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  SupervisorOutputSchema,
  SUPERVISOR_PROMPT_VERSION,
  type SupervisorContext,
} from '@multi-agent-ops/shared';
import { runSupervisor } from './agents/supervisor/runtime.js';
import { SupervisorError } from './agents/supervisor/types.js';

// Actual pinned SDK and native CLI, with a loopback-only fake Anthropic endpoint.
// No business database, real model credential, external provider or fee.
const context: SupervisorContext = {
  schemaVersion: '2.0',
  execution: {
    taskId: 'offline-task',
    attemptId: 'offline-attempt',
    stepId: 'offline-step',
    inputSnapshotId: 'offline-input',
  },
  trigger: 'hot_list_loaded',
  hotList: {
    id: 'offline-board',
    provider: 'xxapi',
    fetchedAt: '2026-11-10T00:00:00Z',
    rankingDescription: null,
    items: [
      {
        id: 'offline-candidate',
        title: 'owner/project',
        description: 'fixture',
        repositoryUrl: 'https://github.com/owner/project',
      },
    ],
  },
  selectedProject: null,
  task: { title: '离线验收', originalRequest: '等待人工选题', referenceInputs: [] },
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
    toolPolicyVersion: 'supervisor-d9-tools-v3',
  },
  contextSelection: { includedRefs: [], omitted: [] },
};
const output = {
  decision: 'awaiting_selection',
  summary: '固定离线决定',
  basisRefs: ['task.originalRequest'],
  defaultsUsed: [],
  warnings: [],
  hotListSnapshotId: 'offline-board',
};

for (const mode of [
  'legacy',
  'global-only',
  'fixed',
  'denied-then-fixed',
  'schema-denied-then-fixed',
  'denied-then-token-limit',
  'reference-denied-then-fixed',
] as const) {
  test(`真实 SDK 工具可见性与输出生成：${mode}`, { timeout: 30000 }, async () => {
    const requests: { path: string; tools: string[] }[] = [];
    let count = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: { name: string }[];
        stream?: boolean;
      };
      const tools = (body.tools ?? []).map((t) => t.name);
      requests.push({ path: req.url ?? '', tools });
      if (!req.url?.includes('/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (++count > 4) {
        res.writeHead(429);
        res.end('{}');
        return;
      }
      const hasTool =
        tools.includes('StructuredOutput') && !(mode === 'denied-then-token-limit' && count > 1);
      const chosen =
        (mode === 'denied-then-fixed' || mode === 'denied-then-token-limit') && count === 1
          ? { ...output, hotListSnapshotId: 'wrong-board' }
          : mode === 'schema-denied-then-fixed' && count === 1
            ? { ...output, summary: 42 }
            : mode === 'reference-denied-then-fixed' && count === 1
              ? {
                  ...output,
                  basisRefs: ['hotList.id'],
                  warnings: [
                    {
                      code: 'offline-warning',
                      message: 'private-warning-body',
                      relatedRefs: ['context.hotList'],
                    },
                  ],
                }
              : output;
      const block = hasTool
        ? {
            type: 'tool_use',
            id: `toolu_offline_${count}`,
            name: 'StructuredOutput',
            input: chosen,
          }
        : { type: 'text', text: JSON.stringify(output) };
      const message = {
        id: `msg_offline_${count}`,
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [block],
        stop_reason: hasTool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: mode === 'denied-then-token-limit' && count > 1 ? 2000 : 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      emit('message_start', {
        type: 'message_start',
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...message.usage, output_tokens: 0 },
        },
      });
      emit('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: hasTool ? { ...block, input: {} } : { type: 'text', text: '' },
      });
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: hasTool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(chosen) }
          : { type: 'text_delta', text: JSON.stringify(output) },
      });
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 40 },
      });
      emit('message_stop', { type: 'message_stop' });
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const run = runSupervisor(context, {
        ...(mode === 'denied-then-token-limit' ? { maxTotalTokens: 1000 } : {}),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DEEPSEEK_API_KEY: 'offline-dummy' },
        limits: {
          timeoutMs: 20000,
          maxTurns: 4,
          maxOutputAttempts: 3,
          maxOutputTokens: 4096,
          maxBudgetUsd: 0.1,
        },
        query: ({ prompt, options }) => {
          options.env = {
            ...options.env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            ANTHROPIC_AUTH_TOKEN: 'offline-dummy',
            NO_PROXY: '127.0.0.1,localhost',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
          };
          if (mode === 'legacy' || mode === 'global-only')
            options.agents!.supervisor!.tools = ['Agent'];
          if (mode === 'global-only') options.tools = ['Agent', 'StructuredOutput'];
          return query({ prompt, options });
        },
      });
      if (mode === 'legacy' || mode === 'global-only') {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof SupervisorError);
          assert.equal(error.diagnostic?.errorType, 'missing_structured_output');
          assert.ok(!error.diagnostic.sdkTrace?.initTools.includes('StructuredOutput'));
          assert.equal(error.diagnostic.sdkTrace?.structuredToolRequests, 0);
          return true;
        });
        assert.ok(requests.every((r) => !r.tools.includes('StructuredOutput')));
      } else if (mode === 'denied-then-token-limit') {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof SupervisorError);
          assert.equal(error.code, 'SUPERVISOR_TOKEN_LIMIT');
          assert.equal(error.diagnostic?.sdkTrace?.tokenObservation?.limit, 1000);
          assert.ok((error.diagnostic?.sdkTrace?.tokenObservation?.observed ?? 0) >= 1000);
          assert.deepEqual(error.diagnostic?.sdkTrace?.outputRejections, [
            {
              code: 'SUPERVISOR_SELECTION_INVALID',
              phase: 'semantic',
              issues: [{ path: 'hotListSnapshotId', code: 'semantic_mismatch' }],
            },
          ]);
          return true;
        });
        assert.equal(count, 2);
      } else {
        const result = await run;
        assert.deepEqual(SupervisorOutputSchema.parse(result.output), output);
        assert.ok(result.metadata.sdkTrace?.initTools.includes('StructuredOutput'));
        assert.ok(result.metadata.sdkTrace?.resultKeys.includes('structured_output'));
        assert.equal(result.metadata.sdkTrace?.structuredToolAllowed, 1);
        assert.equal(
          result.metadata.sdkTrace?.structuredToolDenied,
          mode === 'denied-then-fixed' ||
            mode === 'schema-denied-then-fixed' ||
            mode === 'reference-denied-then-fixed'
            ? 1
            : 0,
        );
        assert.equal(
          count,
          mode === 'denied-then-fixed' ||
            mode === 'schema-denied-then-fixed' ||
            mode === 'reference-denied-then-fixed'
            ? 2
            : 1,
        );
        if (mode === 'reference-denied-then-fixed') {
          const rejected = result.metadata.sdkTrace?.outputRejections?.[0];
          assert.equal(rejected?.code, 'SUPERVISOR_REFERENCE_INVALID');
          assert.deepEqual(
            rejected?.issues.map((i) => i.path),
            ['basisRefs.0', 'warnings.0.relatedRefs.0'],
          );
          assert.deepEqual(rejected?.referenceFailure?.invalidReferences, [
            {
              path: 'basisRefs.0',
              value: 'hotList.id',
              truncated: false,
              reason: 'not_in_allowed_context_reference_set',
            },
            {
              path: 'warnings.0.relatedRefs.0',
              value: 'context.hotList',
              truncated: false,
              reason: 'not_in_allowed_context_reference_set',
            },
          ]);
          assert.ok(!JSON.stringify(rejected).includes('private-warning-body'));
        }
        if (mode === 'denied-then-fixed')
          assert.deepEqual(result.metadata.sdkTrace?.outputRejections, [
            {
              code: 'SUPERVISOR_SELECTION_INVALID',
              phase: 'semantic',
              issues: [{ path: 'hotListSnapshotId', code: 'semantic_mismatch' }],
            },
          ]);
        if (mode === 'schema-denied-then-fixed')
          assert.deepEqual(result.metadata.sdkTrace?.outputRejections, [
            {
              code: 'SUPERVISOR_OUTPUT_INVALID',
              phase: 'schema',
              issues: [{ path: 'summary', code: 'invalid_type' }],
            },
          ]);
        assert.ok(requests.some((r) => r.tools.includes('StructuredOutput')));
      }
      assert.ok(
        requests.every(
          (r) =>
            !r.tools.some((name) =>
              ['Bash', 'Read', 'Write', 'WebFetch', 'WebSearch'].includes(name),
            ),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
