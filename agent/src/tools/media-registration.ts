import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { FETCH_VIDEO_SERVER_NAME, RESEARCH_MEDIA_TOOL_NAMES } from './names.js';
import type { VideoExecution } from './fetch-video/types.js';

type Definitions = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>;
type MediaToolName = (typeof RESEARCH_MEDIA_TOOL_NAMES)[number];

export interface ResearchMediaRegistration {
  toolNames: MediaToolName[];
  execution: VideoExecution;
  timeoutMs: number;
  createTools(signal: AbortSignal): Definitions;
  createServer(signal: AbortSignal): ReturnType<typeof createSdkMcpServer>;
}

export function createMediaRegistration(
  definition: Omit<ResearchMediaRegistration, 'createServer'>,
): ResearchMediaRegistration {
  return {
    ...definition,
    execution: { ...definition.execution },
    createServer(signal) {
      return createSdkMcpServer({
        name: FETCH_VIDEO_SERVER_NAME,
        version: '1.0.0',
        timeout: definition.timeoutMs + 2000,
        tools: definition.createTools(signal),
      });
    },
  };
}

/** One SDK server namespace; do not overwrite fetch_video when adding another media tool. */
export function combineResearchMediaRegistrations(
  ...registrations: ResearchMediaRegistration[]
): ResearchMediaRegistration {
  const first = registrations[0];
  if (!first) throw new Error('至少需要注册一个媒体工具。');
  const names = registrations.flatMap((registration) => registration.toolNames);
  if (new Set(names).size !== names.length) throw new Error('媒体工具不能重复注册。');
  for (const registration of registrations)
    for (const key of ['taskId', 'attemptId', 'inputSnapshotId', 'authorizationId'] as const)
      if (registration.execution[key] !== first.execution[key])
        throw new Error('媒体工具必须属于同一任务、尝试、输入快照及授权。');
  return createMediaRegistration({
    toolNames: names,
    execution: first.execution,
    timeoutMs: Math.max(...registrations.map((registration) => registration.timeoutMs)),
    createTools: (signal) =>
      registrations.flatMap((registration) => registration.createTools(signal)),
  });
}

export function mediaCallSignal(sessionSignal: AbortSignal, extra: unknown): AbortSignal {
  const requestSignal =
    extra !== null &&
    typeof extra === 'object' &&
    'signal' in extra &&
    extra.signal instanceof AbortSignal
      ? extra.signal
      : undefined;
  return requestSignal ? AbortSignal.any([sessionSignal, requestSignal]) : sessionSignal;
}
