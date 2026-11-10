import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  SupervisorSdkTraceSchema,
  type SupervisorSdkTrace,
  type StructuredOutputDiagnostic,
} from '@multi-agent-ops/shared';

/** Fixed labels and bounded rejected references only; no full model text or raw stderr. */
export function createSupervisorSdkTrace() {
  const trace: SupervisorSdkTrace = {
    initTools: [],
    assistantBlockTypes: [],
    stopReasons: [],
    resultKeys: [],
    resultSubtype: null,
    structuredToolRequests: 0,
    structuredToolAllowed: 0,
    structuredToolDenied: 0,
    outputRejections: [],
    stderrCategories: [],
  };
  const add = <T>(items: T[], item: T) => {
    if (!items.includes(item)) items.push(item);
  };
  const stop = (value: unknown) => {
    if (value === null || value === undefined) return;
    add(
      trace.stopReasons,
      value === 'end_turn' ||
        value === 'tool_use' ||
        value === 'max_tokens' ||
        value === 'stop_sequence'
        ? value
        : 'other',
    );
  };
  return {
    message(message: SDKMessage) {
      if (message.type === 'system' && message.subtype === 'init') {
        for (const tool of message.tools ?? [])
          add(
            trace.initTools,
            tool === 'Agent' ||
              tool === 'Task' ||
              tool === 'StructuredOutput' ||
              tool === 'WebSearch' ||
              tool === 'WebFetch'
              ? tool
              : 'other',
          );
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content ?? [])
          add(
            trace.assistantBlockTypes,
            block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use'
              ? block.type
              : 'other',
          );
        stop(message.message.stop_reason);
      }
      if (message.type === 'result') {
        const keys = [
          'structured_output',
          'result',
          'usage',
          'modelUsage',
          'permission_denials',
          'api_error_status',
          'stop_reason',
          'terminal_reason',
          'is_error',
          'subtype',
          'num_turns',
        ] as const;
        trace.resultKeys = keys.filter((key) => Object.hasOwn(message, key));
        const subtype = message.subtype;
        trace.resultSubtype =
          subtype === 'success' ||
          subtype === 'error_during_execution' ||
          subtype === 'error_max_turns' ||
          subtype === 'error_max_budget_usd' ||
          subtype === 'error_max_structured_output_retries'
            ? subtype
            : 'other';
        stop('stop_reason' in message ? message.stop_reason : undefined);
      }
    },
    structuredTool(state: 'requested' | 'allowed' | 'denied') {
      if (state === 'requested') trace.structuredToolRequests++;
      if (state === 'allowed') trace.structuredToolAllowed++;
      if (state === 'denied') trace.structuredToolDenied++;
    },
    tokens(limit: number, observed: number, uniqueMessages: number) {
      trace.tokenObservation = { limit, observed, uniqueMessages };
    },
    outputRejected(code: string, diagnostic?: StructuredOutputDiagnostic) {
      if (trace.outputRejections!.length >= 10) return;
      const parsed = SupervisorSdkTraceSchema.shape.outputRejections.unwrap().element.safeParse({
        code,
        phase:
          diagnostic?.errorType === 'schema_validation_failed'
            ? 'schema'
            : diagnostic?.errorType === 'semantic_validation_failed'
              ? 'semantic'
              : 'policy',
        issues: diagnostic?.issues ?? [],
        ...(code === 'SUPERVISOR_REFERENCE_INVALID' && diagnostic?.referenceFailure
          ? { referenceFailure: diagnostic.referenceFailure }
          : {}),
      });
      if (parsed.success) trace.outputRejections!.push(parsed.data);
    },
    stderr(chunk: string) {
      // Classification only; the chunk is discarded immediately.
      const value = chunk.slice(0, 2048).toLowerCase();
      const category = /authentication|unauthorized|invalid.api.key/.test(value)
        ? 'authentication'
        : /rate.limit|429/.test(value)
          ? 'rate_limit'
          : /timeout|timed.out/.test(value)
            ? 'timeout'
            : /structured.?output|json.schema/.test(value)
              ? 'structured_output'
              : /permission|denied/.test(value)
                ? 'permission'
                : 'other';
      add(trace.stderrCategories, category);
    },
    snapshot: () => structuredClone(trace),
  };
}
