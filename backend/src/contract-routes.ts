import type { FastifyInstance } from 'fastify';
import {
  endpoints,
  getOpenApiDocument,
  RESEARCH_COMMAND_BODY_LIMIT,
  SelectProjectAndAuthorizeResearchSchema,
  RetryResearchAndAuthorizeSchema,
  SubmitMaterialsAndAuthorizeResearchSchema,
} from '@multi-agent-ops/shared';
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
import { editorialOperations } from './editorial-service.js';

const researchRequests = {
  selectProjectAndAuthorizeResearch: SelectProjectAndAuthorizeResearchSchema,
  retryResearchAndAuthorize: RetryResearchAndAuthorizeSchema,
  submitMaterialsAndAuthorizeResearch: SubmitMaterialsAndAuthorizeResearchSchema,
};

export function registerContractRoutes(
  app: FastifyInstance,
  auth: AuthService | undefined,
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
        ...(endpoint.operationId in researchRequests
          ? {
              bodyLimit: RESEARCH_COMMAND_BODY_LIMIT,
              // Validate before AJV's general coercion: authorization must be JSON true.
              preValidation: async (request) => {
                const result = researchRequests[
                  endpoint.operationId as keyof typeof researchRequests
                ].safeParse(request.body);
                if (!result.success)
                  throw new AuthError(
                    400,
                    'VALIDATION_ERROR',
                    '研究请求字段或授权范围无效。',
                    undefined,
                    {
                      conflict: null,
                      fieldErrors: result.error.issues.map((issue) => ({
                        field: `body/${issue.path.join('/')}`,
                        message: issue.message,
                      })),
                    },
                  );
              },
            }
          : {}),
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
            ['listResearchResults', 'getResearchResult', 'getResearchSubmission'].includes(
              endpoint.operationId,
            )
          ) {
            if (!tasks || !request.authSession)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '研究查询服务尚未配置。');
            const params = request.params as {
              taskId: string;
              resultId: string;
              submissionId: string;
            };
            const context = { taskId: params.taskId, actor: request.authSession.member };
            const data =
              endpoint.operationId === 'listResearchResults'
                ? await tasks.listResearchResults({
                    ...context,
                    query: request.query as OperationQueries['listResearchResults'],
                  })
                : endpoint.operationId === 'getResearchResult'
                  ? await tasks.getResearchResult({ ...context, resultId: params.resultId })
                  : await tasks.getResearchSubmission({
                      ...context,
                      submissionId: params.submissionId,
                    });
            return { data, meta: { requestId: request.id, replayed: false } };
          }
          if (
            [
              'selectProjectAndAuthorizeResearch',
              'retryResearchAndAuthorize',
              'submitMaterialsAndAuthorizeResearch',
            ].includes(endpoint.operationId)
          ) {
            if (!tasks) throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '研究服务尚未配置。');
            if (!request.authSession) throw new AuthError(401, 'UNAUTHENTICATED', '请重新登录。');
            const common = {
              taskId: (request.params as { taskId: string }).taskId,
              actor: request.authSession.member,
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            };
            const result = await tasks.researchCommand(
              endpoint.operationId === 'selectProjectAndAuthorizeResearch'
                ? {
                    ...common,
                    operation: 'selectProjectAndAuthorizeResearch',
                    body: request.body as OperationBodies['selectProjectAndAuthorizeResearch'],
                  }
                : endpoint.operationId === 'retryResearchAndAuthorize'
                  ? {
                      ...common,
                      operation: 'retryResearchAndAuthorize',
                      body: request.body as OperationBodies['retryResearchAndAuthorize'],
                    }
                  : {
                      ...common,
                      operation: 'submitMaterialsAndAuthorizeResearch',
                      body: request.body as OperationBodies['submitMaterialsAndAuthorizeResearch'],
                    },
            );
            return reply.code(202).send({
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            });
          }
          if (
            ['getAccountRegistration', 'registerAccount', 'getManualPublicationEntry'].includes(
              endpoint.operationId,
            )
          ) {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '目标账号服务尚未配置。');
            if (!request.authSession) throw new AuthError(401, 'UNAUTHENTICATED', '请重新登录。');
            const actor = request.authSession.member;
            if (endpoint.operationId === 'getManualPublicationEntry') {
              const data = await tasks.manualPublicationEntry({
                ...(request.params as OperationParams['getManualPublicationEntry']),
                actor,
              });
              return { data, meta: { requestId: request.id, replayed: false } };
            }
            const result = await tasks.accountRegistration({
              operation: endpoint.operationId as 'getAccountRegistration' | 'registerAccount',
              actor,
              body: request.body as OperationBodies['registerAccount'],
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            });
            return {
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            };
          }
          if (
            [
              'publishContent',
              'getPublication',
              'listPublications',
              'backfillPublication',
              'verifyPublication',
              'retryPublication',
            ].includes(endpoint.operationId)
          ) {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '发布交接服务尚未配置。');
            if (!request.authSession) throw new AuthError(401, 'UNAUTHENTICATED', '请重新登录。');
            const actor = request.authSession.member;
            const { taskId, operationId } = request.params as OperationParams['getPublication'];
            if (endpoint.operationId === 'retryPublication') {
              const result = await tasks.retryPublication({
                taskId,
                operationId,
                actor,
                body: request.body as OperationBodies['retryPublication'],
                key: request.headers['idempotency-key'] as string,
                requestId: request.id,
              });
              return reply.code(202).send({
                data: result.data,
                meta: { requestId: request.id, replayed: result.replayed },
              });
            }
            if (['backfillPublication', 'verifyPublication'].includes(endpoint.operationId)) {
              const result = await tasks.publicationResult({
                taskId,
                operationId,
                actor,
                kind: endpoint.operationId === 'backfillPublication' ? 'backfill' : 'verification',
                body: request.body as OperationBodies['backfillPublication'],
                key: request.headers['idempotency-key'] as string,
                requestId: request.id,
              });
              return reply.code(202).send({
                data: result.data,
                meta: { requestId: request.id, replayed: result.replayed },
              });
            }
            if (endpoint.operationId === 'publishContent') {
              const result = await tasks.publish({
                taskId,
                actor,
                body: request.body as OperationBodies['publishContent'],
                key: request.headers['idempotency-key'] as string,
                requestId: request.id,
              });
              return reply.code(202).send({
                data: result.data,
                meta: { requestId: request.id, replayed: result.replayed },
              });
            }
            const data =
              endpoint.operationId === 'getPublication'
                ? await tasks.getPublication({ taskId, operationId, actor })
                : await tasks.listPublications({
                    taskId,
                    actor,
                    query: request.query as OperationQueries['listPublications'],
                  });
            return { data, meta: { requestId: request.id, replayed: false } };
          }
          if (endpoint.operationId === 'terminateTask') {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '任务终止服务尚未配置。');
            if (!request.authSession) throw new AuthError(401, 'UNAUTHENTICATED', '请重新登录。');
            const result = await tasks.terminate({
              taskId: (request.params as OperationParams['terminateTask']).taskId,
              actor: request.authSession.member,
              body: request.body as OperationBodies['terminateTask'],
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            });
            return reply.code(202).send({
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            });
          }
          if (editorialOperations.has(endpoint.operationId)) {
            if (!tasks)
              throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '人工编辑审核服务尚未配置。');
            if (!request.authSession) throw new AuthError(401, 'UNAUTHENTICATED', '请重新登录。');
            const result = await tasks.editorial({
              operation: endpoint.operationId,
              actor: request.authSession.member,
              params: request.params as Record<string, string>,
              query: request.query as Record<string, unknown>,
              body: request.body,
              key: request.headers['idempotency-key'] as string,
              requestId: request.id,
            });
            return reply.code(result.status).send({
              data: result.data,
              meta: { requestId: request.id, replayed: result.replayed },
            });
          }
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
