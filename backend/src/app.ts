import Fastify from 'fastify';
import type { AgentHealth, DatabaseReadiness, ServiceHealth } from '@multi-agent-ops/shared';
import { registerContractRoutes } from './contract-routes.js';

type Dependencies = {
  checkDatabase: () => Promise<DatabaseReadiness>;
  checkAgent: () => Promise<AgentHealth>;
};

export function createApp(dependencies: Dependencies) {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
  });
  registerContractRoutes(app);
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
