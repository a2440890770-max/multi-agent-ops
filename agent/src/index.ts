import type { AgentHealth } from '@multi-agent-ops/shared';

export * from './agents/supervisor/index.js';
export * from './integrations/xxapi/github-hot.js';

export function describeAgent(): AgentHealth {
  return { service: 'agent', status: 'ok', stage: 'D1', mode: 'shell', canExecuteTasks: false };
}
