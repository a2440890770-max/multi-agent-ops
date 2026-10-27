export const PROJECT_NAME = 'Multi-Agent Ops';
export interface ServiceHealth {
  service: 'backend' | 'agent';
  status: 'ok';
  stage: 'D1';
}
export interface AgentHealth extends ServiceHealth {
  service: 'agent';
  mode: 'shell';
  canExecuteTasks: false;
}
export interface DatabaseReadiness {
  status: 'ready' | 'not_ready';
  database: 'connected' | 'unconfigured' | 'unavailable';
}
