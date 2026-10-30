import type { FastifyInstance } from 'fastify';
import { endpoints, getOpenApiDocument } from '@multi-agent-ops/shared';
import type {
  ApiError,
  OperationBodies,
  OperationParams,
  OperationQueries,
} from '@multi-agent-ops/shared';
import { authOperations } from './auth-routes.js';
import { registerBusinessAuthorization } from './authorization.js';
import { AuthError } from './auth.js';
import type { AuthService } from './auth.js';
import type { TaskService } from './task-service.js';

export function registerContractRoutes(
  app: FastifyInstance,
  auth: AuthService | undefined,
  tasks?: Pick<
    TaskService,
    'create' | 'get' | 'list' | 'start' | 'retry' | 'stop' | 'history' | 'clarify'
  >,
) {
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
          if (
            ['startTask', 'retryTask', 'stopAttempt', 'taskHistory', 'clarifyTask'].includes(
              endpoint.operationId,
            )
          ) {
            if (!tasks) throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '执行服务尚未配置。');
            if (!request.authSession)
              throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
            const { taskId } = request.params as { taskId: string };
            const actor = request.authSession.member;
            if (endpoint.operationId === 'taskHistory') {
              const data = await tasks.history({
                taskId,
                actor,
                query: request.query as OperationQueries['taskHistory'],
              });
              return { data, meta: { requestId: request.id, replayed: false } };
            }
            const context = {
              taskId,
              actor,
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            };
            const result =
              endpoint.operationId === 'startTask'
                ? await tasks.start({
                    ...context,
                    body: request.body as OperationBodies['startTask'],
                  })
                : endpoint.operationId === 'retryTask'
                  ? await tasks.retry({
                      ...context,
                      body: request.body as OperationBodies['retryTask'],
                    })
                  : endpoint.operationId === 'clarifyTask'
                    ? await tasks.clarify({
                        ...context,
                        body: request.body as OperationBodies['clarifyTask'],
                      })
                    : await tasks.stop({
                        ...context,
                        attemptId: (request.params as OperationParams['stopAttempt']).attemptId,
                        body: request.body as OperationBodies['stopAttempt'],
                      });
            return reply.code(202).send({
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            });
          }
          if (endpoint.operationId === 'listTasks') {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务查询服务尚未配置。');
            if (!request.authSession)
              throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
            const data = await tasks.list({
              query: request.query as OperationQueries['listTasks'],
              actor: request.authSession.member,
            });
            return { data, meta: { requestId: request.id, replayed: false } };
          }
          if (endpoint.operationId === 'getTask') {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务查询服务尚未配置。');
            if (!request.authSession)
              throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
            const { taskId } = request.params as OperationParams['getTask'];
            const data = await tasks.get({ taskId, actor: request.authSession.member });
            return { data, meta: { requestId: request.id, replayed: false } };
          }
          if (endpoint.operationId === 'createTask') {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务保存服务尚未配置。');
            if (!request.authSession)
              throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
            const result = await tasks.create({
              body: request.body as OperationBodies['createTask'],
              actor: request.authSession.member,
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            });
            return reply.code(201).send({
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            });
          }
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
