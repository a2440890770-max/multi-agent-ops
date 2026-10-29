import type { ApiError, ApiSuccess, Session } from '@multi-agent-ops/shared';

export class AuthRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function authRequest<T>(
  operation: 'login' | 'me' | 'logout',
  options: { body?: unknown; key?: string; csrf?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/auth/${operation}`, {
      method: operation === 'me' ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new AuthRequestError(0, '暂时无法确认请求结果，请检查连接并重新检查登录状态。');
  }
  let body: ApiSuccess<T> | ApiError;
  try {
    body = await response.json();
  } catch {
    throw new AuthRequestError(503, '登录服务响应异常，请稍后重试。');
  }
  if (!body || typeof body !== 'object')
    throw new AuthRequestError(503, '登录服务响应异常，请稍后重试。');
  if (!response.ok) {
    const message =
      response.status === 429
        ? `登录尝试过于频繁，请在 ${Math.max(1, Math.ceil((Number(response.headers.get('retry-after')) || 900) / 60))} 分钟后重试。`
        : response.status === 401 && operation === 'login'
          ? '账号或密码错误。'
          : response.status === 403
            ? '请求安全校验未通过，请重新检查登录状态后再试。'
            : response.status >= 500
              ? '登录服务暂不可用，请稍后重新检查登录状态。'
              : 'error' in body
                ? body.error.message
                : '请求未完成，请稍后再试。';
    throw new AuthRequestError(response.status, message);
  }
  if (!('data' in body)) throw new AuthRequestError(503, '登录服务响应异常，请稍后重试。');
  return body.data;
}

export function validSession(value: Session): boolean {
  return !!(
    value &&
    value.member &&
    typeof value.member.id === 'string' &&
    typeof value.member.teamId === 'string' &&
    typeof value.member.displayName === 'string' &&
    Number.isInteger(value.member.version) &&
    value.member.version >= 1 &&
    ['admin', 'operator'].includes(value.member.role) &&
    value.member.status === 'active' &&
    Array.isArray(value.permissions) &&
    value.permissions.every((permission) => typeof permission === 'string') &&
    typeof value.csrfToken === 'string' &&
    value.csrfToken.length > 0 &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.now()
  );
}
