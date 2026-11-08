import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentOutput } from '@multi-agent-ops/shared';

export class ContentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}
export type ContentQuery = (request: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close(): void };

export interface ContentRunOptions {
  limits: {
    timeoutMs: number;
    maxTurns: number;
    maxBudgetUsd: number;
    maxOutputTokens: number;
    maxOutputAttempts: number;
  };
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  query?: ContentQuery;
  onEvent?: (event: {
    taskId: string;
    attemptId: string;
    inputSnapshotId: string;
    kind: 'started' | 'skill_read' | 'output_rejected' | 'completed' | 'failed';
    code?: string;
  }) => void;
}

export interface ContentRunResult {
  output: ContentOutput;
  metadata: {
    provider: 'deepseek' | 'bailian';
    baseUrl: string;
    model: string;
    sessionId: string | null;
    promptVersion: string;
    toolPolicyVersion: string;
    skill: { id: string; version: string; sha256: string };
    inputSnapshotId: string;
    durationMs: number;
    outputAttempts: number;
    observationErrors: number;
    turns: number | null;
    sdkEstimatedCostUsd: number | null;
    modelUsage: { model: string; inputTokens: number; outputTokens: number }[];
  };
}
