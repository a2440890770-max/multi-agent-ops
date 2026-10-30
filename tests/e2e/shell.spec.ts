import { expect, test } from '@playwright/test';
import { mockAuth } from './auth-fixture.js';

test('工作台使用真实后端及 Agent 健康检查，并如实显示数据库状态', async ({ page, request }) => {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get('http://127.0.0.1:3001/api/agent-health')).status();
        } catch {
          return 0; // Vite can become ready before the backend has opened its port.
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  const ready = await request.get('http://127.0.0.1:3001/api/ready');
  const database = (await ready.json()) as { database: string };
  if (process.env.EXPECT_DATABASE_READY === '1') expect(ready.status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Multi-Agent Ops', exact: true })).toBeVisible();
  await expect(
    page.getByRole('article').filter({ has: page.getByRole('heading', { name: '后端服务' }) }),
  ).toContainText('已连接');
  await expect(
    page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Agent 空壳' }) }),
  ).toContainText('已连接');
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '业务数据库' }) });
  await expect(card).toContainText(
    database.database === 'connected'
      ? '已连接'
      : database.database === 'unconfigured'
        ? '待配置'
        : '未连接',
  );
  await expect(page.getByText('独立入口 · 尚无执行能力')).toBeVisible();
});

test('移动端不出现横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('业务导航可直接刷新；管理布局使用后端返回的当前身份', async ({ page }) => {
  const fixture = await mockAuth(page);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: '每一个想法，都有迹可循' })).toBeVisible();
  await page.screenshot({ path: 'test-results/d1-tasks-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '记忆管理', exact: true }).click();
  await expect(page).toHaveURL(/\/memories$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: '让经验有来源，也有边界' })).toBeVisible();
  await page.getByRole('link', { name: '管理设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '此页面仅管理员可用' })).toBeVisible();
  fixture.state.role = 'admin';
  await page.reload();
  await expect(page.getByRole('button', { name: '基础规则与版本' })).toBeVisible();
});

test('冲突保留输入；工作/发布锁和未保存输入阻断关键操作', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/previews/tasks/task-demo');
  await page.screenshot({ path: 'test-results/d1-task-detail-desktop.png', fullPage: true });
  const editor = page.getByRole('textbox', { name: '当前文案', exact: true });
  await editor.fill('我的修改不能被覆盖');
  await expect(page.getByRole('button', { name: '批准当前版本', exact: true })).toBeDisabled();
  await page.getByLabel('预览场景', { exact: true }).selectOption('conflict');
  await expect(editor).toHaveValue('我的修改不能被覆盖');
  await page.getByRole('button', { name: '查看最新版本并比较' }).click();
  await expect(page.getByRole('heading', { name: '服务器最新版本 V4' })).toBeVisible();
  await expect(editor).toHaveValue('我的修改不能被覆盖');
  await page.getByLabel('预览场景', { exact: true }).selectOption('stopping');
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  await page.getByLabel('预览场景', { exact: true }).selectOption('verification');
  await expect(page.getByRole('button', { name: '重新执行', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '人工发布交接', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '核实原发送结果' })).toBeVisible();
  await page.getByLabel('预览场景', { exact: true }).selectOption('published');
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: '复制为新任务', exact: true })).toBeEnabled();
});

test('移动端业务页面保持导航且页面本身无横向溢出', async ({ page }) => {
  await mockAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    '/tasks',
    '/previews/tasks/task-demo',
    '/memories',
    '/evaluations',
    '/settings',
    '/login',
    '/tasks/new',
  ]) {
    await page.goto(route);
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      elements: Array.from(document.querySelectorAll('body *'))
        .filter(
          (element) =>
            element.getBoundingClientRect().right > window.innerWidth &&
            getComputedStyle(element.parentElement!).overflowX !== 'auto',
        )
        .slice(0, 10)
        .map(
          (element) =>
            `${element.tagName}.${element.className}: ${Math.round(element.getBoundingClientRect().right)}`,
        ),
    }));
    expect(overflow.width <= overflow.viewport, `${route}: ${JSON.stringify(overflow)}`).toBe(true);
  }
});
