import type { AgentHealth } from '@multi-agent-ops/shared';

export * from './agents/supervisor/index.js';
export * from './agents/research/index.js';
export * from './integrations/xxapi/github-hot.js';
export * from './tools/fetch-video/index.js';
export * from './tools/extract-audio/index.js';
export * from './tools/transcribe-audio/index.js';
export * from './tools/extract-frames/index.js';
export * from './tools/research-web/index.js';
export {
  combineResearchMediaRegistrations,
  type ResearchMediaRegistration,
} from './tools/media-registration.js';

/** Legacy shell descriptor. Live readiness is reported by createAgentService(). */
export function describeAgent(): AgentHealth {
  return { service: 'agent', status: 'ok', stage: 'D1', mode: 'shell', canExecuteTasks: false };
}
