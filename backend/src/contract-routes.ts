import type { FastifyInstance } from 'fastify';
import { endpoints, getOpenApiDocument } from '@multi-agent-ops/shared';
import type { ApiError } from '@multi-agent-ops/shared';
import { authOperations } from './auth-routes.js';
import { registerBusinessAuthorization } from './authorization.js';
import type { AuthService } from './auth.js';

export function registerContractRoutes(app: FastifyInstance, auth: AuthService | undefined) {
  app.get('/api/v1/openapi.json', async () => getOpenApiDocument());
  app.register(async (business) => {
    registerBusinessAuthorization(business, auth);
    for (const endpoint of endpoints) {
      if (authOperations.has(endpoint.operationId)) continue;
      business.route({
        method: endpoint.method,
        url: `/api/v1${endpoint.path}`,
        config: { requiredRoles: endpoint.roles },
        schema: {
          ...(endpoint.body ? { body: endpoint.body } : {}),
          ...(endpoint.query ? { querystring: endpoint.query } : {}),
          ...(endpoint.method !== 'GET'
            ? {
                headers: {
                  type: 'object',
                  properties: {
                    'idempotency-key': { type: 'string', minLength: 16, maxLength: 128 },
                  },
                  required: ['idempotency-key'],
                },
              }
            : {}),
          params: {
            type: 'object',
            properties: Object.fromEntries(
              [...endpoint.path.matchAll(/:([A-Za-z]+)/g)].map((m) => [
                m[1],
                { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
              ]),
            ),
            additionalProperties: false,
          },
        },
        handler: async (request, reply) => {
          const body: ApiError = {
            error: {
              code: 'NOT_IMPLEMENTED',
              message: `${endpoint.summary}：D1 契约已定义，业务能力尚未实现`,
              retryable: false,
              fieldErrors: [],
              conflict: null,
              operationId: null,
              dispatchId: null,
            },
            meta: { requestId: request.id },
          };
          return reply.code(501).send(body);
        },
      });
    }
  });
}
