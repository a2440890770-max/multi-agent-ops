import { expect, test } from '@playwright/test';

test('工作台使用真实后端及 Agent 健康检查，并如实显示数据库状态', async ({ page, request }) => {
  await expect
    .poll(async () => (await request.get('http://127.0.0.1:3001/api/agent-health')).status())
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
