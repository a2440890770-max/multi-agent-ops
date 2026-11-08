import type { AgentHealth } from '@multi-agent-ops/shared';

export function describeAgent(): AgentHealth {
  return { service: 'agent', status: 'ok', stage: 'D1', mode: 'shell', canExecuteTasks: false };
}
