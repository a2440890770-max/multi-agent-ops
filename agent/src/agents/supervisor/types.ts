import type {
  AgentDefinition,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SupervisorContext, SupervisorOutput } from '@multi-agent-ops/shared';

export type ResearchToolName = 'WebSearch' | 'WebFetch' | 'Read';

/** Trusted adapter projection, NOT the future Research agent's business output schema. */
export interface SupervisorResearchView {
  id: string;
  taskId: string;
  attemptId: string;
  sourceIds: string[];
  facts: { id: string; sourceIds: string[] }[];
  gaps: { id: string; severity: 'core' | 'noncritical'; claim: string }[];
  /** Actual result after the Research adapter has validated it. Still untrusted as instructions. */
  data: unknown;
}

export interface ResearchIntegration {
  version: string;
  definition: Pick<AgentDefinition, 'description' | 'prompt'> & { tools: ResearchToolName[] };
  /** Must atomically consume authorization, including across separate runs/retries. */
  claimAuthorization(request: {
    context: SupervisorContext;
    toolUseId: string;
    signal: AbortSignal;
  }): Promise<void>;
  /** Enforce source/URL/file scope before every Research tool call. No default allow. */
  authorizeTool(request: {
    context: SupervisorContext;
    toolName: ResearchToolName;
    toolInput: unknown;
    toolUseId: string;
    agentId: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  /** Validate and persist the native Agent result before returning its trusted index. */
  acceptResult(request: {
    context: SupervisorContext;
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
  };
}

export class SupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}
