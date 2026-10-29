import type { FastifyInstance } from 'fastify';
import { endpoints } from '@multi-agent-ops/shared';
import type { ApiError, OperationBodies } from '@multi-agent-ops/shared';
import { AuthError, cookieToken } from './auth.js';
import type { AuthService } from './auth.js';

export const authOperations = new Set(['login', 'getMe', 'logout']);

function cookie(token: string, expiresAt: string, secure: boolean) {
  return `ops_session=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService | undefined) {
  for (const endpoint of endpoints.filter((entry) => authOperations.has(entry.operationId))) {
    app.route({
      method: endpoint.method,
      url: `/api/v1${endpoint.path}`,
      schema: {
        ...(endpoint.body ? { body: endpoint.body } : {}),
        ...(endpoint.operationId === 'login'
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
      },
      onRequest: async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        reply.header('pragma', 'no-cache');
      },
      errorHandler(error, request, reply) {
        const failure =
          error instanceof AuthError
            ? error
            : error.validation
              ? new AuthError(400, 'VALIDATION_ERROR', '请求字段不符合认证接口契约。')
              : error.statusCode && error.statusCode < 500
                ? new AuthError(400, 'VALIDATION_ERROR', '请求格式无效。')
                : new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '认证服务暂不可用，请稍后再试。');
        if (failure.status >= 500)
          app.log.warn({ requestId: request.id, code: failure.code }, '认证请求未完成');
        if (failure.retryAfter) reply.header('retry-after', failure.retryAfter);
        const body: ApiError = {
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.status === 503,
            fieldErrors: (error.validation ?? []).map((entry) => ({
              field: `${error.validationContext ?? ''}${entry.instancePath}`,
              message: entry.message ?? '字段无效',
            })),
            conflict: null,
            operationId: null,
            dispatchId: null,
          },
          meta: { requestId: request.id },
        };
        return reply.code(failure.status).send(body);
      },
      handler: async (request, reply) => {
        const token = cookieToken(request.headers.cookie);
        if (endpoint.operationId === 'getMe' && !token)
          throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
        if (!auth)
          throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '认证服务尚未配置，请联系管理员。');
        if (endpoint.method !== 'GET') auth.assertOrigin(request.headers.origin);
        if (endpoint.operationId === 'login') {
          const body = request.body as OperationBodies['login'];
          const result = await auth.login({
            login: body.login,
            password: body.password,
            key: request.headers['idempotency-key'] as string,
            origin: request.headers.origin!,
            ip: request.ip,
            requestId: request.id,
          });
          reply.header(
            'set-cookie',
            cookie(result.token, result.data.expiresAt, auth.config.secureCookie),
          );
          return { data: result.data, meta: { requestId: request.id, replayed: result.replayed } };
        }
        if (endpoint.operationId === 'getMe')
          return { data: await auth.me(token), meta: { requestId: request.id, replayed: false } };
        await auth.logout(token, request.headers['x-csrf-token'] as string | undefined, request.id);
        reply.header(
          'set-cookie',
          cookie('', new Date(0).toISOString(), auth.config.secureCookie) + '; Max-Age=0',
        );
        return { data: { signedOut: true }, meta: { requestId: request.id, replayed: false } };
      },
    });
  }
}
