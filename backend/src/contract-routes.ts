import type { FastifyInstance } from 'fastify';
import { endpoints, getOpenApiDocument } from '@multi-agent-ops/shared';
import type { ApiError, ErrorCode } from '@multi-agent-ops/shared';

export function registerContractRoutes(app: FastifyInstance) {
  // These routes deliberately never invoke the database, Agent or publication provider.
  app.get('/api/v1/openapi.json', async () => getOpenApiDocument());
  for (const endpoint of endpoints) {
    app.route({
      method: endpoint.method,
      url: `/api/v1${endpoint.path}`,
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
                required: endpoint.operationId === 'logout' ? [] : ['idempotency-key'],
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
      errorHandler(error, request, reply) {
        const invalid =
          !!error.validation || (error.statusCode !== undefined && error.statusCode < 500);
        const code: ErrorCode = invalid ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
        const body: ApiError = {
          error: {
            code,
            message: invalid
              ? '请求字段或 JSON 格式不符合 D1 契约'
              : '服务发生内部错误，请使用请求编号排查',
            retryable: false,
            fieldErrors: (error.validation ?? []).map((v) => ({
              field: `${error.validationContext ?? ''}${v.instancePath}${v.keyword === 'required' ? `/${String(v.params.missingProperty)}` : ''}`,
              message: v.message ?? '字段无效',
            })),
            conflict: null,
            operationId: null,
            dispatchId: null,
          },
          meta: { requestId: request.id },
        };
        return reply.code(invalid ? 400 : 500).send(body);
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
}
