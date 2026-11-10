import Fastify from 'fastify';
import type { AgentHealth, DatabaseReadiness, ServiceHealth } from '@multi-agent-ops/shared';
import { registerContractRoutes } from './contract-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { AuthService } from './auth.js';
import type { TaskService } from './task-service.js';
import type { Writable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';

type Dependencies = {
  checkDatabase: () => Promise<DatabaseReadiness>;
  checkAgent: () => Promise<AgentHealth>;
  auth?: AuthService;
  tasks?: Pick<
    TaskService,
    | 'create'
    | 'get'
    | 'list'
    | 'start'
    | 'retry'
    | 'stop'
    | 'terminate'
    | 'history'
    | 'clarify'
    | 'researchCommand'
    | 'listResearchResults'
    | 'getResearchResult'
    | 'getResearchSubmission'
    | 'editorial'
    | 'accountRegistration'
    | 'manualPublicationEntry'
    | 'publish'
    | 'getPublication'
    | 'listPublications'
    | 'publicationResult'
    | 'retryPublication'
  >;
  logging?: boolean;
  logStream?: Writable;
  agentRuns?: {
    serviceToken: string;
    checkRun: (body: unknown) => Promise<boolean>;
    researchCallback?: (
      body: unknown,
    ) => Promise<{ accepted: boolean; replayed?: boolean; execute?: boolean }>;
  };
};

export function createApp(dependencies: Dependencies) {
  const app = Fastify({
    logger:
      dependencies.logging === false
        ? false
        : {
            ...(dependencies.logStream ? { stream: dependencies.logStream } : {}),
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-csrf-token"]',
              'req.body.password',
              'body.password',
              'password',
              'passwordHash',
              'token',
              'csrfToken',
              'res.headers["set-cookie"]',
              'req.body.lease',
            ],
          },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
    routerOptions: { maxParamLength: 128 },
  });
  registerAuthRoutes(app, dependencies.auth);
  registerContractRoutes(app, dependencies.auth, dependencies.tasks);
  app.post('/internal/v1/agent-runs/check', { bodyLimit: 16_384 }, async (request, reply) => {
    const service = dependencies.agentRuns;
    if (!service) return reply.code(503).send({ allowed: false });
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (
      !timingSafeEqual(
        digest(request.headers.authorization ?? ''),
        digest(`Bearer ${service.serviceToken}`),
      )
    )
      return reply.code(401).send({ allowed: false });
    const allowed = await service.checkRun(request.body);
    return reply.code(allowed ? 200 : 409).send({ allowed });
  });
  app.post(
    '/internal/v1/research/events',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const service = dependencies.agentRuns;
      if (!service?.researchCallback) return reply.code(503).send({ accepted: false });
      const digest = (value: string) => createHash('sha256').update(value).digest();
      if (
        !timingSafeEqual(
          digest(request.headers.authorization ?? ''),
          digest(`Bearer ${service.serviceToken}`),
        )
      )
        return reply.code(401).send({ accepted: false });
      const result = await service.researchCallback(request.body);
      return reply.code(result.accepted ? 200 : 409).send(result);
    },
  );
  app.get('/api/health', async (): Promise<ServiceHealth> => ({
    service: 'backend',
    status: 'ok',
    stage: 'D1',
  }));
  app.get('/api/ready', async (_request, reply) => {
    const result = await dependencies.checkDatabase();
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
  app.get('/api/agent-health', async (_request, reply) => {
    try {
      return await dependencies.checkAgent();
    } catch {
      return reply.code(503).send({ status: 'unavailable', service: 'agent' });
    }
  });
  return app;
}
