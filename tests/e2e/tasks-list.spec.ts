import { expect, test } from '@playwright/test';
import { makePreviewTask } from '../../frontend/src/preview.js';
import { mockAuth } from './auth-fixture.js';

const endpoint = /\/api\/v1\/tasks(?:\?.*)?$/;
function item(id: string, title: string) {
  const value = makePreviewTask('draft', id);
  return {
    ...value,
    task: { ...value.task, title, createdBy: 'ui-member', teamId: 'ui-team' },
    execution: null,
  };
}
test('真实列表请求、分页、搜索和状态筛选传递到接口，详情使用真实路径', async ({ page }) => {
  await mockAuth(page);
  const requests: URLSearchParams[] = [];
  await page.route(endpoint, (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const filtered = query.has('q') || query.has('execution');
    return route.fulfill({
      json: {
        data: {
          items: filtered
            ? []
            : [
                query.has('cursor')
                  ? item('stored-2', '第二页真实任务')
                  : item('stored-1', '已保存的真实任务'),
              ],
          nextCursor: filtered || query.has('cursor') ? null : 'next-page',
        },
        meta: { requestId: 'list-test', replayed: false },
      },
    });
  });
  await page.goto('/tasks');
  await expect(page.getByRole('link', { name: '已保存的真实任务', exact: true })).toHaveAttribute(
    'href',
    '/tasks/stored-1',
  );
  await expect(page.getByText('task-demo', { exact: false })).toHaveCount(0);
  await expect(page.locator('.preview-banner')).toHaveCount(0);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('link', { name: '第二页真实任务', exact: true })).toBeVisible();
  await expect(page.getByText('已加载 2 项任务')).toBeVisible();
  expect(requests.at(-1)!.get('cursor')).toBe('next-page');
  await page.getByLabel('搜索任务').fill('指定标题');
  await expect(page.getByRole('heading', { name: '没有符合条件的任务' })).toBeVisible();
  expect(requests.at(-1)!.get('q')).toBe('指定标题');
  expect(requests.at(-1)!.has('cursor')).toBe(false);
  await page.getByRole('button', { name: '执行中', exact: true }).click();
  await expect.poll(() => requests.at(-1)!.get('execution')).toBe('running');
  expect(requests.at(-1)!.get('q')).toBe('指定标题');
  await expect(page.getByRole('link', { name: '已保存的真实任务', exact: true })).toHaveCount(0);
});

test('列表失败显示错误而非空结果，重试重新读取数据', async ({ page }) => {
  await mockAuth(page);
  let calls = 0;
  let failing = true;
  await page.route(endpoint, (route) => {
    calls++;
    return failing
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'DEPENDENCY_UNAVAILABLE' }, meta: { requestId: 'failure' } },
        })
      : route.fulfill({
          json: {
            data: { items: [item('stored-1', '重试后可见任务')], nextCursor: null },
            meta: { requestId: 'retry', replayed: false },
          },
        });
  });
  await page.goto('/tasks');
  await expect(page.getByRole('alert')).toContainText('暂不可用');
  await expect(page.getByRole('heading', { name: '没有符合条件的任务' })).toHaveCount(0);
  const beforeRetry = calls;
  failing = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('link', { name: '重试后可见任务', exact: true })).toBeVisible();
  expect(calls).toBe(beforeRetry + 1);
});
