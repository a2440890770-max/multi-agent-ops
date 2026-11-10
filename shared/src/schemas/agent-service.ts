import { z } from 'zod';
import {
  SupervisorContextSchema,
  SupervisorOutputSchema,
  SupervisorReferenceFailureSchema,
} from './supervisor.js';
import { ResearchAcceptedResultSchema } from './research.js';
import { GithubHotListSchema } from './research.js';
import { ResearchAuthorizationScopeSchema } from './research-commands.js';
import { ResearchWebConfigSchema } from './research-web.js';

/** Safe metadata plus explicitly scoped rejected reference strings; no full model text. */
export const SupervisorSdkTraceSchema = z.strictObject({
  initTools: z
    .array(z.enum(['Agent', 'Task', 'StructuredOutput', 'WebSearch', 'WebFetch', 'other']))
    .max(6),
  assistantBlockTypes: z.array(z.enum(['text', 'thinking', 'tool_use', 'other'])).max(4),
  stopReasons: z
    .array(z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'other']))
    .max(5),
  resultKeys: z
    .array(
      z.enum([
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
      ]),
    )
    .max(11),
  resultSubtype: z
    .enum([
      'success',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
      'other',
    ])
    .nullable(),
  structuredToolRequests: z.int().nonnegative(),
  structuredToolAllowed: z.int().nonnegative(),
  structuredToolDenied: z.int().nonnegative(),
  tokenObservation: z
    .strictObject({
      limit: z.int().positive(),
      observed: z.int().nonnegative(),
      uniqueMessages: z.int().nonnegative(),
    })
    .optional(),
  outputRejections: z
    .array(
      z.strictObject({
        code: z.enum([
          'SUPERVISOR_OUTPUT_INVALID',
          'SUPERVISOR_REFERENCE_INVALID',
          'SUPERVISOR_DEFAULT_INVALID',
          'SUPERVISOR_SELECTION_INVALID',
          'SUPERVISOR_SELECTION_REQUIRED',
          'SUPERVISOR_RESEARCH_REQUIRED',
          'SUPERVISOR_GAP_INVALID',
          'SUPERVISOR_EVIDENCE_INSUFFICIENT',
          'SUPERVISOR_CLAIM_INVALID',
          'SUPERVISOR_EXCLUSION_INVALID',
          'SUPERVISOR_OUTPUT_ATTEMPTS_EXHAUSTED',
          'RESEARCH_NOT_COMPLETED',
        ]),
        phase: z.enum(['schema', 'semantic', 'policy']),
        referenceFailure: SupervisorReferenceFailureSchema.optional(),
        issues: z
          .array(
            z.strictObject({
              path: z.string().max(512),
              code: z
                .string()
                .regex(/^[a-z_]+$/)
                .max(64),
            }),
          )
          .max(20),
      }),
    )
    .max(10)
    .optional(),
  stderrCategories: z
    .array(
      z.enum([
        'authentication',
        'rate_limit',
        'timeout',
        'structured_output',
        'permission',
        'other',
      ]),
    )
    .max(6),
});
export type SupervisorSdkTrace = z.infer<typeof SupervisorSdkTraceSchema>;
export const StructuredOutputDiagnosticSchema = z.strictObject({
  hasStructuredOutput: z.boolean(),
  errorType: z.enum([
    'sdk_error',
    'missing_structured_output',
    'schema_validation_failed',
    'semantic_validation_failed',
  ]),
  outputType: z.enum(['undefined', 'null', 'array', 'object', 'string', 'number', 'boolean']),
  issues: z
    .array(
      z.strictObject({
        path: z.string().max(512),
        code: z
          .string()
          .regex(/^[a-z_]+$/)
          .max(64),
      }),
    )
    .max(20),
  sdkTrace: SupervisorSdkTraceSchema.optional(),
  referenceFailure: SupervisorReferenceFailureSchema.optional(),
});
export type StructuredOutputDiagnostic = z.infer<typeof StructuredOutputDiagnosticSchema>;

/** Private backend/Agent protocol; execution credentials never belong in a model prompt. */
export const AgentExecutionLeaseSchema = z.strictObject({
  executorId: z.uuid(),
  claimToken: z.uuid(),
  generation: z.int().positive(),
});
export const SupervisorLimitsSchema = z.strictObject({
  timeoutMs: z.int().min(1).max(3_600_000),
  maxTurns: z.int().min(1).max(100),
  maxBudgetUsd: z.number().positive().max(100),
  maxOutputTokens: z.int().min(1).max(64_000),
  maxOutputAttempts: z.int().min(1).max(10),
});
export const SupervisorEventSchema = z.strictObject({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  stepId: z.string().min(1),
  inputSnapshotId: z.string().min(1),
  kind: z.enum([
    'started',
    'research_requested',
    'research_accepted',
    'research_tool_failed',
    'tool_denied',
    'output_rejected',
    'completed',
    'failed',
  ]),
  code: z.string().optional(),
  toolUseId: z.string().optional(),
});
export const SupervisorRunResultSchema = z.strictObject({
  output: SupervisorOutputSchema,
  researchResults: z.array(ResearchAcceptedResultSchema),
  metadata: z.strictObject({
    model: z.string().min(1),
    sessionId: z.string().nullable(),
    promptVersion: z.string(),
    toolPolicyVersion: z.string(),
    researchVersion: z.string().nullable(),
    configVersion: z.int().positive(),
    inputSnapshotId: z.string().min(1),
    durationMs: z.number().nonnegative(),
    outputAttempts: z.int().nonnegative(),
    researchDispatched: z.boolean(),
    observationErrors: z.int().nonnegative(),
    turns: z.int().nonnegative().nullable(),
    /** SDK estimate, not a provider invoice or an implicit USD/CNY conversion. */
    sdkEstimatedCostUsd: z.number().nonnegative().nullable(),
    modelUsage: z.array(
      z.strictObject({
        model: z.string(),
        inputTokens: z.int().nonnegative(),
        outputTokens: z.int().nonnegative(),
      }),
    ),
    sdkTrace: SupervisorSdkTraceSchema.optional(),
  }),
});
export const AgentRunRequestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  lease: AgentExecutionLeaseSchema,
  context: SupervisorContextSchema,
  limits: SupervisorLimitsSchema,
  maxTotalTokens: z.int().positive(),
  acceptedResearchResults: z.array(ResearchAcceptedResultSchema),
  research: z
    .strictObject({
      scope: ResearchAuthorizationScopeSchema,
      webConfig: ResearchWebConfigSchema.omit({ root: true }),
    })
    .optional(),
});
export const AgentRunResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  result: SupervisorRunResultSchema,
  events: z.array(SupervisorEventSchema).max(1000),
});
export const AgentRunCheckSchema = z.strictObject({
  runId: z.uuid(),
  lease: AgentExecutionLeaseSchema,
  execution: SupervisorContextSchema.shape.execution,
  phase: z.enum(['begin', 'check']).optional(),
  contextHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type AgentExecutionLease = z.infer<typeof AgentExecutionLeaseSchema>;
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;
export type AgentRunCheck = z.infer<typeof AgentRunCheckSchema>;
export type SupervisorLimits = z.infer<typeof SupervisorLimitsSchema>;
export type SupervisorEvent = z.infer<typeof SupervisorEventSchema>;
export type SupervisorRunResult = z.infer<typeof SupervisorRunResultSchema>;
export const GithubHotAcquisitionSchema = z.strictObject({
  list: GithubHotListSchema,
  rawResponse: z.unknown(),
  parserVersion: z.literal('xxapi-github-hot-v1'),
});
export type GithubHotAcquisition = z.infer<typeof GithubHotAcquisitionSchema>;
