import { expect, test } from '@playwright/test';
import { mockAuth, submitLogin } from './auth-fixture.js';

test('未登录访问受保护页面，登录后返回原页面；刷新恢复真实角色并安全退出', async ({ page }) => {
  const fixture = await mockAuth(page, { authenticated: false, role: 'admin' });
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('heading', { name: '成员登录', exact: true })).toBeVisible();
  await submitLogin(page);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('.sidebar-footer')).toContainText('测试成员');
  await expect(page.locator('.sidebar-footer')).toContainText('管理员');
  await expect(page.getByRole('button', { name: '基础规则与版本' })).toBeVisible();
  await expect(page.getByLabel('预览身份（非登录）')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '基础规则与版本' })).toBeVisible();
  const storage = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
  }));
  expect(storage.local).toBe(0);
  expect(storage.session).toBe(0);
  expect(storage.cookies).not.toContain('ops_session');
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'ops_session')?.httpOnly).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('已退出登录。', { exact: true })).toBeVisible();
  expect(fixture.state.authenticated).toBe(false);
  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/login\?next=/);
});

test('凭据错误保留账号、清空密码；限流展示等待时间且不自动重试', async ({ page }) => {
  const fixture = await mockAuth(page, { authenticated: false });
  fixture.state.failLogin = 401;
  await page.goto('/login');
  await submitLogin(page);
  await expect(page.getByRole('alert')).toContainText('账号或密码错误');
  await expect(page.getByLabel('登录账号', { exact: true })).toHaveValue('ui-test-member');
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  fixture.state.failLogin = 429;
  await submitLogin(page);
  await expect(page.getByRole('alert')).toContainText('15 分钟');
  const writes = fixture.requests.filter((request) => request.operation === 'login');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.key).not.toBe(writes[1]!.key);
});

test('登录已成功但身份查询失败时，仅重查会话，不重复提交账号密码', async ({ page }) => {
  const fixture = await mockAuth(page, { authenticated: false, role: 'admin' });
  fixture.state.failAuthenticatedMe = 503;
  await page.goto('/login');
  await submitLogin(page);
  await expect(page.getByText('登录服务暂不可用，请稍后重新检查登录状态。')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  fixture.state.failAuthenticatedMe = 0;
  await page.getByRole('button', { name: '重新检查登录状态' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(fixture.requests.filter((request) => request.operation === 'login')).toHaveLength(1);
});

test('后端会话失效后刷新返回登录页，不恢复旧权限', async ({ page }) => {
  const fixture = await mockAuth(page, { role: 'admin' });
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: '基础规则与版本' })).toBeVisible();
  fixture.state.authenticated = false;
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole('button', { name: '基础规则与版本' })).toHaveCount(0);
});

test('页面内会话到期即回到登录，未自动执行任何写入', async ({ page }) => {
  const fixture = await mockAuth(page, { expiresAt: new Date(Date.now() + 2500).toISOString() });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: '每一个想法，都有迹可循' })).toBeVisible();
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 6000 });
  await expect(page.getByText('登录已过期，请重新登录。')).toBeVisible();
  expect(fixture.requests.filter((request) => request.operation !== 'me')).toHaveLength(0);
});

test('退出失败保留身份，服务端确认成功后才切换到未登录', async ({ page }) => {
  const fixture = await mockAuth(page);
  fixture.state.failLogout = 503;
  await page.goto('/tasks');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByText('登录服务暂不可用，请稍后重新检查登录状态。')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.locator('.sidebar-footer')).toContainText('测试成员');
  fixture.state.failLogout = 0;
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('登录返回地址仅允许站内已知页面，拒绝外站和畸形 URL', async ({ page }) => {
  await mockAuth(page);
  for (const next of [
    'https://evil.example',
    '//evil.example',
    'http://[invalid',
    '/login',
    '/unknown',
  ]) {
    await page.goto('/login?next=' + encodeURIComponent(next));
    await expect(page).toHaveURL(/\/tasks$/);
  }
});

test('初始服务不可用时可恢复检查，登录及退出在手机上保持可用', async ({ page }) => {
  const fixture = await mockAuth(page, { authenticated: false });
  fixture.state.failMe = 503;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: '重新检查登录状态' })).toBeVisible();
  fixture.state.failMe = 0;
  await page.getByRole('button', { name: '重新检查登录状态' }).click();
  await submitLogin(page);
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('登录进行中窗口恢复焦点，不会被较早的未登录查询覆盖', async ({ page }) => {
  const fixture = await mockAuth(page, { authenticated: false });
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/auth/login', async (route) => {
    await pending;
    await route.fallback();
  });
  await page.goto('/login');
  await submitLogin(page);
  await expect(page.getByRole('button', { name: '正在登录…' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  release!();
  await expect(page).toHaveURL(/\/tasks$/);
  expect(fixture.requests.filter((request) => request.operation === 'login')).toHaveLength(1);
});

test('一个标签页退出后，另一标签页收到身份变化并返回登录', async ({ page, context }) => {
  await mockAuth(page);
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  const other = await context.newPage();
  const second = await mockAuth(other);
  await other.goto('/settings');
  await expect(other.getByRole('heading', { name: '此页面仅管理员可用' })).toBeVisible();
  second.state.authenticated = false;
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(other).toHaveURL(/\/login\?next=/);
  await other.close();
});
