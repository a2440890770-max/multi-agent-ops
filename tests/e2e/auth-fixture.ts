import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Role, Session } from '@multi-agent-ops/shared';

export async function mockAuth(
  page: Page,
  options: { authenticated?: boolean; role?: Role; expiresAt?: string } = {},
) {
  const state = {
    authenticated: options.authenticated ?? true,
    role: options.role ?? 'operator',
    expiresAt: options.expiresAt ?? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    failLogin: 0,
    failMe: 0,
    failAuthenticatedMe: 0,
    failLogout: 0,
  };
  const requests: { operation: string; key: string | undefined; csrf: string | undefined }[] = [];
  const session = (): Session => ({
    member: {
      id: 'ui-member',
      teamId: 'ui-team',
      displayName: '测试成员',
      role: state.role,
      status: 'active',
      version: 1,
    },
    permissions: state.role === 'admin' ? ['tasks:write', 'settings:write'] : ['tasks:write'],
    csrfToken: 'c'.repeat(43),
    expiresAt: state.expiresAt,
  });
  // Only browser tests intercept these endpoints. Production code has no mock login path.
  await page.route('**/api/v1/auth/*', async (route) => {
    const request = route.request();
    const operation = new URL(request.url()).pathname.split('/').at(-1)!;
    const headers = request.headers();
    requests.push({ operation, key: headers['idempotency-key'], csrf: headers['x-csrf-token'] });
    const error = (status: number) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'retry-after': '900' },
        body: JSON.stringify({
          error: {
            code: status === 401 ? 'UNAUTHENTICATED' : 'DEPENDENCY_UNAVAILABLE',
            message: 'Synthetic auth error',
          },
          meta: { requestId: 'ui-test' },
        }),
      });
    if (operation === 'me') {
      if (state.failMe || (state.authenticated && state.failAuthenticatedMe))
        return error(state.failMe || state.failAuthenticatedMe);
      if (!state.authenticated) return error(401);
      return route.fulfill({
        json: { data: session(), meta: { requestId: 'ui-test', replayed: false } },
      });
    }
    expect(headers.origin).toBe(new URL(request.url()).origin);
    if (operation === 'login') {
      expect(request.method()).toBe('POST');
      expect(headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      const payload = request.postDataJSON() as { login: string; password: string };
      expect(payload.login).toBe('ui-test-member');
      expect(payload.password).toBe('synthetic-ui-password');
      if (state.failLogin) return error(state.failLogin);
      state.authenticated = true;
      return route.fulfill({
        headers: {
          'set-cookie': 'ops_session=synthetic-ui-session; Path=/; HttpOnly; SameSite=Lax',
        },
        json: { data: session(), meta: { requestId: 'ui-test', replayed: false } },
      });
    }
    expect(operation).toBe('logout');
    expect(headers['x-csrf-token']).toBe(session().csrfToken);
    if (state.failLogout) return error(state.failLogout);
    state.authenticated = false;
    return route.fulfill({
      headers: { 'set-cookie': 'ops_session=; Path=/; Max-Age=0; HttpOnly' },
      json: { data: { signedOut: true }, meta: { requestId: 'ui-test', replayed: false } },
    });
  });
  return { state, requests };
}

export async function submitLogin(page: Page) {
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
  await page.getByLabel('登录账号', { exact: true }).fill('ui-test-member');
  await page.getByLabel('密码', { exact: true }).fill('synthetic-ui-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
