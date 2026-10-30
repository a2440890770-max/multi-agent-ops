import { expect, test } from '@playwright/test';
import type { OperationBodies, TaskDetail } from '@multi-agent-ops/shared';
import { makePreviewTask } from '../../frontend/src/preview.js';
import { mockAuth } from './auth-fixture.js';

const taskId = '456d2bf2-8851-45f0-ac73-67d752e71332';
const title = '前端创建闭环';
const original = '  保留这段原始要求。\n第二行包含空格。\n';
function draftDetail(payload: OperationBodies['createTask'], id = taskId): TaskDetail {
  const detail = makePreviewTask('draft', id);
  detail.task = {
    ...detail.task,
    title: payload.title,
    originalRequest: payload.originalRequest,
    teamId: 'ui-team',
    createdBy: 'ui-member',
    accountId: null,
    referenceInputs: (payload.referenceInputs ?? []).map((r, index) => ({
      id: `ref-${index}`,
      ...r,
    })),
    clarifications: [],
    lifecycle: 'open',
    revision: 1,
    currentAttemptId: null,
    currentContentVersionId: null,
    currentReviewCycleId: null,
    currentApprovalId: null,
    activePublishOperationId: null,
    publishedOperationId: null,
  };
  return {
    ...detail,
    account: null,
    execution: null,
    approval: 'not_requested',
    publication: 'not_published',
    currentStep: null,
    errorMessage: null,
    currentAttempt: null,
    currentContent: null,
    currentReview: null,
    currentApproval: null,
    currentPublication: null,
    latestReflection: null,
    workLock: null,
    actions: {
      ...detail.actions,
      start: { allowed: true, reason: null },
      retry: { allowed: false, reason: '尚无执行记录。' },
      stop: { allowed: false, reason: '尚无执行记录。' },
    },
  };
}
const apiError = (code: string, message: string) => ({
  error: { code, message },
  meta: { requestId: 'ui-task-error' },
});
async function fillTask(page: import('@playwright/test').Page) {
  await page.getByLabel('任务标题').fill(title);
  await page.getByLabel('主题与目标').fill(original);
}

test('创建页面真实提交、显示加载和防重复点击，成功进入详情并清理草稿', async ({ page }) => {
  await mockAuth(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved: TaskDetail | undefined;
  const writes: { key: string; body: OperationBodies['createTask'] }[] = [];
  await page.route('**/api/v1/tasks', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe('c'.repeat(43));
    const body = request.postDataJSON() as OperationBodies['createTask'];
    writes.push({ key: request.headers()['idempotency-key']!, body });
    saved = draftDetail(body);
    await held;
    await route.fulfill({
      status: 201,
      json: { data: saved, meta: { requestId: 'created', replayed: false } },
    });
  });
  await page.route(`**/api/v1/tasks/${taskId}`, async (route) => {
    expect(route.request().headers()['idempotency-key']).toBeUndefined();
    expect(route.request().headers()['x-csrf-token']).toBeUndefined();
    await route.fulfill({ json: { data: saved, meta: { requestId: 'read', replayed: false } } });
  });
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByLabel('参考资料名称').fill('产品文档');
  await page.getByLabel('参考资料链接').fill('https://example.com/product');
  await page.locator('form').evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByRole('button', { name: '正在创建…' })).toBeDisabled();
  await expect(page.getByLabel('任务标题')).toBeDisabled();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toEqual({
    title,
    originalRequest: original,
    referenceInputs: [{ label: '产品文档', url: 'https://example.com/product' }],
  });
  expect(writes[0]!.key).toMatch(/^[a-f0-9-]{36}$/);
  release();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(await page.getByTestId('original-request').textContent()).toBe(original);
  await expect(
    page.getByRole('link', { name: 'https://example.com/product', exact: true }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.preview-banner')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await expect(page.getByRole('button', { name: '启动模拟执行', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发布内容', exact: true })).toBeDisabled();
});

test('提交失败保留原文，确定未接受的校验失败可修改后再次提交', async ({ page }) => {
  await mockAuth(page);
  const keys: string[] = [];
  let saved: TaskDetail;
  await page.route('**/api/v1/tasks', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1)
      return route.fulfill({ status: 400, json: apiError('VALIDATION_ERROR', '请补充具体主题。') });
    saved = draftDetail(route.request().postDataJSON() as OperationBodies['createTask']);
    return route.fulfill({
      status: 201,
      json: { data: saved, meta: { requestId: 'created', replayed: false } },
    });
  });
  await page.route(`**/api/v1/tasks/${taskId}`, (route) =>
    route.fulfill({ json: { data: saved, meta: { requestId: 'read', replayed: false } } }),
  );
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请补充具体主题');
  await expect(page.getByLabel('主题与目标')).toHaveValue(original);
  await expect(page.getByLabel('任务标题')).toBeEnabled();
  await page.getByLabel('任务标题').fill('更具体的任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '更具体的任务', exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test('网络结果不明确时刷新保留输入和原请求，只在手动重试时复用相同动作键', async ({ page }) => {
  await mockAuth(page);
  const keys: string[] = [];
  let saved: TaskDetail;
  await page.route('**/api/v1/tasks', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) return route.abort('failed');
    saved = draftDetail(route.request().postDataJSON() as OperationBodies['createTask']);
    return route.fulfill({
      status: 201,
      json: { data: saved, meta: { requestId: 'replayed', replayed: true } },
    });
  });
  await page.route(`**/api/v1/tasks/${taskId}`, (route) =>
    route.fulfill({ json: { data: saved, meta: { requestId: 'read', replayed: false } } }),
  );
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeEnabled();
  await expect(page.getByLabel('主题与目标')).toHaveValue(original);
  await expect(page.getByLabel('任务标题')).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeEnabled();
  expect(keys).toHaveLength(1);
  await page.getByRole('button', { name: '重试确认本次提交' }).click();
  await expect(page).toHaveURL(`/tasks/${taskId}`);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('登录过期后保留输入，重新登录回到创建页；未接受的提交不自动重试', async ({ page }) => {
  const fixture = await mockAuth(page);
  let writes = 0;
  await page.route('**/api/v1/tasks', async (route) => {
    writes++;
    fixture.state.authenticated = false;
    return route.fulfill({ status: 401, json: apiError('UNAUTHENTICATED', '登录已失效') });
  });
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  fixture.state.authenticated = true;
  await page.reload();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByLabel('任务标题')).toHaveValue(title);
  await expect(page.getByLabel('主题与目标')).toHaveValue(original);
  await expect(page.getByRole('button', { name: '创建任务', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
});

test('必填和空白要求在提交前拦截，草稿按成员隔离', async ({ page }) => {
  await mockAuth(page);
  let writes = 0;
  await page.route('**/api/v1/tasks', async (route) => {
    writes++;
    await route.abort();
  });
  await page.goto('/tasks/new');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  expect(writes).toBe(0);
  await page.getByLabel('任务标题').fill(' ');
  await page.getByLabel('主题与目标').fill(' \n ');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能只输入空白');
  expect(writes).toBe(0);
  await fillTask(page);
  await page.evaluate(() => {
    const own = sessionStorage.getItem('ops-task-draft-v1:ui-team:ui-member')!;
    sessionStorage.removeItem('ops-task-draft-v1:ui-team:ui-member');
    sessionStorage.setItem('ops-task-draft-v1:other-team:other-member', own);
  });
  await page.reload();
  await expect(page.getByLabel('任务标题')).toHaveValue('');
  await expect(page.getByLabel('主题与目标')).toHaveValue('');
});

test('详情展示加载、服务错误及重试成功，实际呈现当前步骤和错误信息', async ({ page }) => {
  await mockAuth(page);
  const data = draftDetail({ title, originalRequest: original });
  data.execution = 'failed';
  data.currentStep = 'research';
  data.errorMessage = '搜索暂时失败';
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let failing = true;
  await page.route(`**/api/v1/tasks/${taskId}`, async (route) => {
    reads++;
    if (failing) {
      await held;
      return route.fulfill({
        status: 503,
        json: apiError('DEPENDENCY_UNAVAILABLE', 'private database details'),
      });
    }
    return route.fulfill({ json: { data, meta: { requestId: 'read', replayed: false } } });
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText('正在加载任务详情…', { exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: '任务加载失败', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('private database details');
  const failedReads = reads;
  failing = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('research', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('搜索暂时失败');
  expect(reads).toBe(failedReads + 1);
});

test('真实详情路径对不存在和无权限显示错误，不回退到示例任务', async ({ page }) => {
  await mockAuth(page);
  await page.route('**/api/v1/tasks/*', (route) =>
    route.fulfill({
      status: route.request().url().endsWith('forbidden') ? 403 : 404,
      json: apiError('NOT_FOUND', '不存在'),
    }),
  );
  await page.goto('/tasks/task-demo');
  await expect(
    page.getByRole('heading', { name: '任务不存在或无权查看', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('预览场景')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '秋日灵感计划' })).toHaveCount(0);
  await page.goto('/tasks/forbidden');
  await expect(page.getByRole('heading', { name: '无权查看此任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检查登录状态' })).toBeVisible();
});

test('手机上真实详情和创建表单不溢出，原文按文本展示且不执行 HTML', async ({ page }) => {
  await mockAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const data = draftDetail({
    title: 'long-title-'.repeat(10),
    originalRequest: '<img src=x onerror=alert(1)>\n' + 'longword'.repeat(100),
    referenceInputs: [{ label: '参考', url: 'https://example.com/' + 'a'.repeat(300) }],
  });
  await page.route(`**/api/v1/tasks/${taskId}`, (route) =>
    route.fulfill({ json: { data, meta: { requestId: 'read', replayed: false } } }),
  );
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId('original-request')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByTestId('original-request').locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/d4-real-detail-mobile.png', fullPage: true });
  await page.goto('/tasks/new');
  await expect(page.getByRole('button', { name: '创建任务', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('身份切换后清除先前详情并重新校验团队访问，不能继续显示旧团队内容', async ({ page }) => {
  const fixture = await mockAuth(page);
  const data = draftDetail({ title, originalRequest: original });
  await page.route(`**/api/v1/tasks/${taskId}`, (route) =>
    fixture.state.teamId === 'ui-team'
      ? route.fulfill({ json: { data, meta: { requestId: 'read', replayed: false } } })
      : route.fulfill({ status: 404, json: apiError('NOT_FOUND', '不存在') }),
  );
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  fixture.state.teamId = 'other-team';
  fixture.state.memberId = 'other-member';
  await page.evaluate(() => {
    new BroadcastChannel('ops-auth').postMessage({ type: 'changed' });
  });
  await expect(
    page.getByRole('heading', { name: '任务不存在或无权查看', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('original-request')).toHaveCount(0);
});

test('过期的未确认提交不能盲目重新创建', async ({ page }) => {
  await mockAuth(page);
  let writes = 0;
  await page.route('**/api/v1/tasks', async (route) => {
    writes++;
    await route.abort('failed');
  });
  await page.goto('/tasks/new');
  await fillTask(page);
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeEnabled();
  await page.evaluate(() => {
    const key = 'ops-task-draft-v1:ui-team:ui-member';
    const draft = JSON.parse(sessionStorage.getItem(key)!);
    draft.pending.startedAt = Date.now() - 24 * 60 * 60 * 1000;
    sessionStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '重试确认本次提交' })).toBeDisabled();
  await expect(page.getByText('这次提交已超过可直接重试的时限', { exact: false })).toBeVisible();
  expect(writes).toBe(1);
});
