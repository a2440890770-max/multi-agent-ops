import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError, Role, Session } from '@multi-agent-ops/shared';
import { AuthError, cookieToken } from './auth.js';
import type { AuthService } from './auth.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    requiredRoles?: readonly Role[];
  }
  interface FastifyRequest {
    authSession: Session | null;
  }
}

/** Install inside the business-route scope; public/authentication routes stay outside. */
export function registerBusinessAuthorization(app: FastifyInstance, auth: AuthService | undefined) {
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
    const token = cookieToken(request.headers.cookie);
    if (!token) throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
    if (!auth)
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '认证服务尚未配置，请联系管理员。');
    try {
      // Missing role declarations deny access, including on newly added routes.
      request.authSession = await auth.authorize(
        token,
        request.routeOptions.config.requiredRoles ?? [],
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
          ? undefined
          : {
              origin: request.headers.origin,
              csrf:
                typeof request.headers['x-csrf-token'] === 'string'
                  ? request.headers['x-csrf-token']
                  : undefined,
            },
      );
    } catch (error) {
      if (error instanceof AuthError) throw error;
      // Database failures must not expose driver messages or allow requests through.
      throw new AuthError(503, 'DEPENDENCY_UNAVAILABLE', '认证服务暂不可用，请稍后再试。');
    }
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const invalid =
      !!error.validation || (error.statusCode !== undefined && error.statusCode < 500);
    const failure =
      error instanceof AuthError
        ? error
        : invalid
          ? new AuthError(400, 'VALIDATION_ERROR', '请求字段或 JSON 格式不符合接口契约。')
          : new AuthError(500, 'INTERNAL_ERROR', '服务发生内部错误，请使用请求编号排查。');
    if (failure.status >= 500)
      app.log.warn({ requestId: request.id, code: failure.code }, '业务请求未完成');
    const body: ApiError = {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.status === 503,
        fieldErrors: (error.validation ?? []).map((entry) => ({
          field: `${error.validationContext ?? ''}${entry.instancePath}${entry.keyword === 'required' ? `/${String(entry.params.missingProperty)}` : ''}`,
          message: entry.message ?? '字段无效',
        })),
        conflict: null,
        operationId: null,
        dispatchId: null,
      },
      meta: { requestId: request.id },
    };
    return reply.code(failure.status).send(body);
  });
}
