import assert from 'node:assert/strict';
import test from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SupervisorSdkTraceSchema } from '@multi-agent-ops/shared';
import { createSupervisorSdkTrace } from './agents/supervisor/sdk-trace.js';

test('SDK 诊断只保留固定分类，不记录未知工具名、正文、结果或原始错误', () => {
  const trace = createSupervisorSdkTrace();
  for (const message of [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput', 'private-tool-name'] },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'private-model-text' }],
        stop_reason: 'private-stop-reason',
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'private-result',
      structured_output: { privateField: 'private-value' },
      privateKey: 'private',
    },
  ])
    trace.message(message as unknown as SDKMessage);
  trace.stderr('Authentication failed: private-secret');
  trace.stderr('private-raw-error');
  trace.structuredTool('requested');
  trace.structuredTool('denied');
  trace.outputRejected('private-error-code');
  trace.outputRejected('SUPERVISOR_OUTPUT_INVALID', {
    hasStructuredOutput: true,
    errorType: 'schema_validation_failed',
    outputType: 'object',
    issues: [{ path: 'summary', code: 'invalid_type' }],
  });
  const saved = SupervisorSdkTraceSchema.parse(trace.snapshot());
  assert.deepEqual(saved.initTools, ['StructuredOutput', 'other']);
  assert.deepEqual(saved.stderrCategories, ['authentication', 'other']);
  assert.equal(saved.structuredToolDenied, 1);
  assert.deepEqual(saved.outputRejections, [
    {
      code: 'SUPERVISOR_OUTPUT_INVALID',
      phase: 'schema',
      issues: [{ path: 'summary', code: 'invalid_type' }],
    },
  ]);
  assert.ok(!JSON.stringify(saved).includes('private'));
});
