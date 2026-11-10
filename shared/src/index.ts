export const PROJECT_NAME = 'Multi-Agent Ops';
export * from './domain.js';
export * from './api.js';
export * from './contracts.js';
export type { ResponseModels } from './responses.js';
export * from './generated/request-models.js';
export * from './schemas/supervisor.js';
export * from './schemas/supervisor-validation.js';
export * from './schemas/research.js';
export * from './schemas/research-validation.js';
export * from './schemas/research-web.js';
export * from './schemas/research-commands.js';
export * from './schemas/fetch-video.js';
export * from './schemas/extract-audio.js';
export * from './schemas/transcribe-audio.js';
export * from './schemas/extract-frames.js';
export * from './schemas/agent-service.js';
export * from './schemas/research-execution.js';
export interface ServiceHealth {
  service: 'backend' | 'agent';
  status: 'ok';
  stage: 'D1';
}
export interface AgentHealth extends ServiceHealth {
  service: 'agent';
  mode: 'shell' | 'supervisor';
  canExecuteTasks: boolean;
}
export interface DatabaseReadiness {
  status: 'ready' | 'not_ready';
  database: 'connected' | 'unconfigured' | 'unavailable';
}
