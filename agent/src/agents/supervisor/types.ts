import type {
  AgentDefinition,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ResearchAcceptedResult,
  ResearchContext,
  SupervisorContext,
  SupervisorOutput,
  StructuredOutputDiagnostic,
  SupervisorSdkTrace,
} from '@multi-agent-ops/shared';
import type { ResearchMediaRegistration } from '../../tools/media-registration.js';
import type { ResearchToolName } from '../../tools/names.js';
import type { ResearchWebController } from '../../tools/research-web/controller.js';

export type { ResearchToolName } from '../../tools/names.js';

/** One shared accepted-result contract; no independently maintained fact/gap projection. */
export type SupervisorResearchView = ResearchAcceptedResult;

export interface ResearchIntegration {
  version: string;
  definition: Pick<
    AgentDefinition,
    'description' | 'prompt' | 'model' | 'skills' | 'background' | 'omitClaudeMd' | 'maxTurns'
  > & { tools: ResearchToolName[] };
  /** Formal integrations check loaded Skill metadata before opening an SDK session. */
  validateRuntimeContext?(context: ResearchContext['runtimeContext']): void;
  /** Only this explicitly registered in-process media server can be attached. */
  mediaTools?: ResearchMediaRegistration;
  webTools?: ResearchWebController;
  /** Must atomically consume authorization, including across separate runs/retries. */
  claimAuthorization(request: {
    sdkSessionId?: string;
    context: SupervisorContext;
    researchContext: ResearchContext;
    toolUseId: string;
    signal: AbortSignal;
  }): Promise<void>;
  startAgent?(request: {
    context: SupervisorContext;
    researchContext: ResearchContext;
    toolUseId: string;
    agentId: string;
    sdkSessionId: string;
    signal: AbortSignal;
  }): Promise<void>;
  validateReport?(request: {
    researchContext: ResearchContext;
    output: unknown;
    signal: AbortSignal;
  }): Promise<void>;
  /** Enforce source/URL/file scope before every Research tool call. No default allow. */
  authorizeTool(request: {
    context: SupervisorContext;
    researchContext: ResearchContext;
    toolName: ResearchToolName;
    toolInput: unknown;
    toolUseId: string;
    agentId: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  /** Validate and persist the native Agent result before returning its trusted index. */
  acceptResult(request: {
    context: SupervisorContext;
    researchContext: ResearchContext;
    toolUseId: string;
    rawResult: unknown;
    signal: AbortSignal;
  }): Promise<SupervisorResearchView>;
}

export interface SupervisorLimits {
  timeoutMs: number;
  maxTurns: number;
  maxBudgetUsd: number;
  maxOutputTokens: number;
  maxOutputAttempts: number;
}

export interface SupervisorEvent {
  taskId: string;
  attemptId: string;
  stepId: string;
  inputSnapshotId: string;
  kind:
    | 'started'
    | 'research_requested'
    | 'research_accepted'
    | 'research_tool_failed'
    | 'tool_denied'
    | 'output_rejected'
    | 'completed'
    | 'failed';
  code?: string;
  toolUseId?: string;
}

/** Injectable transport for offline tests. Production uses SDK query(), not a custom agent loop. */
export type SupervisorQuery = (request: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close(): void };

export interface SupervisorRunOptions {
  limits: SupervisorLimits;
  /** Stop after observed model usage reaches this session reservation. */
  maxTotalTokens?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  research?: ResearchIntegration;
  /** In the same order as context.researchContext.acceptedResultIds; last is current. */
  acceptedResearchResults?: SupervisorResearchView[];
  onEvent?: (event: SupervisorEvent) => void;
  query?: SupervisorQuery;
}

export interface SupervisorRunResult {
  output: SupervisorOutput;
  researchResults: SupervisorResearchView[];
  metadata: {
    model: string;
    sessionId: string | null;
    promptVersion: string;
    toolPolicyVersion: string;
    researchVersion: string | null;
    configVersion: number;
    inputSnapshotId: string;
    durationMs: number;
    outputAttempts: number;
    researchDispatched: boolean;
    observationErrors: number;
    turns: number | null;
    /** SDK estimates only, not a provider bill or the backend's persistent task ledger. */
    sdkEstimatedCostUsd: number | null;
    modelUsage: { model: string; inputTokens: number; outputTokens: number }[];
    sdkTrace?: SupervisorSdkTrace;
  };
}

export class SupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostic?: StructuredOutputDiagnostic,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}
