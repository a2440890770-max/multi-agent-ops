import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ResponseModels } from '@multi-agent-ops/shared';
import { makePreviewTask } from '../../frontend/src/preview.js';
import { mockAuth } from './auth-fixture.js';

const taskId = 'd60602b6-77c8-41c2-9bd1-2b2b2286e510';
function fixture() {
  const detail = makePreviewTask('ready', taskId);
  detail.task.teamId = 'ui-team';
  detail.task.createdBy = 'ui-member';
  detail.approval = 'not_requested';
  detail.currentApproval = null;
  detail.currentReview!.trigger = 'initial_generation';
  detail.currentReview!.records[0]!.scores = [{ name: '综合质量', value: 90, source: 'rule' }];
  detail.currentReview!.records[0]!.suggestions = [];
  detail.currentReview!.records[0]!.factualEvidenceSufficient = true;
  detail.currentAttempt!.executorMode = 'mock';
  detail.currentAttempt!.simulationScenario = 'success';
  detail.currentAttempt!.autoRevisionCount = 0;
  detail.currentContent!.sourceKind = 'agent';
  detail.currentContent!.revisionRound = 0;
  detail.actions.review = { allowed: true, reason: null };
  const history: ResponseModels['History'] = {
    attempts: [],
    contents: [],
    reviews: [],
    decisions: [],
    steps: [],
    clarificationAnswers: [],
    audit: { items: [], nextCursor: null },
  };
  for (let number = 1; number <= 5; number++) {
    const attempt = { ...detail.currentAttempt!, id: `attempt-${number}`, attemptNo: number };
    const content = {
      ...detail.currentContent!,
      id: `content-${number}`,
      versionNo: number,
      originAttemptId: attempt.id,
      body: `第 ${number} 次执行的文案`,
    };
    const review = structuredClone(detail.currentReview!);
    review.id = `review-${number}`;
    review.attemptId = attempt.id;
    review.inputVersionId = content.id;
    review.currentVersionId = content.id;
    Object.assign(review.records[0]!, {
      id: `record-${number}`,
      cycleId: review.id,
      contentVersionId: content.id,
    });
    history.attempts.unshift(attempt);
    history.contents.push(content);
    history.reviews.push(review);
    detail.currentAttempt = attempt;
    detail.currentContent = content;
    detail.currentReview = review;
  }
  detail.task.currentAttemptId = detail.currentAttempt!.id;
  detail.task.currentContentVersionId = detail.currentContent!.id;
  detail.task.currentReviewCycleId = detail.currentReview!.id;
  return { detail, history };
}

async function open(page: Page, value: ReturnType<typeof fixture>) {
  await mockAuth(page);
  await page.route(`**/api/v1/tasks/${taskId}`, (route) =>
    route.fulfill({
      json: { data: value.detail, meta: { requestId: 'workflow-detail', replayed: false } },
    }),
  );
  await page.route(`**/api/v1/tasks/${taskId}/history`, (route) =>
    route.fulfill({
      json: { data: value.history, meta: { requestId: 'workflow-history', replayed: false } },
    }),
  );
  await page.goto(`/tasks/${taskId}`);
}

test('评分和建议跟随对应执行展示，快捷入口可定位且不混入其他执行版本', async ({ page }) => {
  await open(page, fixture());
  const panel = page.getByRole('region', { name: '审核与人工处理' });
  await expect(panel).toContainText('90/100');
  await expect(panel).toContainText('本次审核未提出修改建议。');
  await expect(panel).toContainText('当前审核已通过，无需人工裁决');
  const attempts = page.getByTestId('execution-attempt');
  await expect(attempts).toHaveCount(5);
  for (let index = 0; index < 5; index++) {
    const attempt = attempts.nth(index);
    await expect(attempt).toContainText(`第 ${5 - index} 次执行`);
    await expect(attempt.getByTestId('content-version')).toHaveCount(1);
    await expect(attempt.getByTestId('content-version')).toContainText(`V${5 - index}`);
    await expect(attempt).toContainText('审核评分');
    await expect(attempt).toContainText('90/100');
    await expect(attempt).toContainText('本次审核未提出修改建议。');
  }
  await page.getByRole('link', { name: '每版文案、评分与建议', exact: true }).click();
  await expect(page.getByRole('heading', { name: '执行尝试记录', exact: true })).toBeInViewport();
  await page.getByRole('link', { name: '审核与人工处理', exact: true }).click();
  await expect(
    panel.getByRole('heading', { name: '审核与人工处理', exact: true }),
  ).toBeInViewport();
  for (const name of ['编辑文案', '提交当前版本重审', '调整要求并新执行', '终止任务'])
    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
});

test('审核建议直接可见，主观分歧显示裁决，填写原因后可操作', async ({ page }) => {
  const value = fixture();
  const record = value.detail.currentReview!.records[0]!;
  record.outcome = 'changes_required';
  record.scores[0]!.value = 55;
  record.suggestions = ['开头更贴近用户的使用情景。'];
  record.blockingIssues = [
    { id: 'subjective-1', kind: 'subjective', message: '语气需要调整', resolved: false },
  ];
  value.detail.execution = 'manual_required';
  await open(page, value);
  const panel = page.getByRole('region', { name: '审核与人工处理' });
  await expect(panel).toContainText('55/100');
  await expect(panel).toContainText('开头更贴近用户的使用情景。');
  await expect(panel.getByRole('button', { name: '记录人工裁决', exact: true })).toBeDisabled();
  await panel.getByLabel('操作或裁决原因').fill('已确认主观表达适合受众');
  await expect(panel.getByRole('button', { name: '记录人工裁决', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: '终止任务', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '调整要求并新执行', exact: true }).click();
  await expect(panel.getByLabel('新执行要求')).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '保存要求并开始新执行', exact: true }),
  ).toBeEnabled();
});

test('事实证据不足时显示阻断解释，99分不能打开裁决操作', async ({ page }) => {
  const value = fixture();
  const record = value.detail.currentReview!.records[0]!;
  record.outcome = 'changes_required';
  record.scores[0]!.value = 99;
  record.factualEvidenceSufficient = false;
  record.blockingIssues = [
    { id: 'factual-1', kind: 'factual', message: '缺少证据', resolved: false },
  ];
  await open(page, value);
  const panel = page.getByRole('region', { name: '审核与人工处理' });
  await expect(panel).toContainText('99/100');
  await expect(panel).toContainText('事实证据与基础规则阻断必须修改后重审，不能人工裁决放行。');
  await expect(panel.getByRole('button', { name: '记录人工裁决', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('运行中人工接管后进入编辑，刷新不覆盖本地草稿', async ({ page }) => {
  const value = fixture();
  value.detail.execution = 'running';
  value.detail.currentAttempt!.status = 'running';
  value.detail.workLock = {
    ownerType: 'attempt',
    ownerId: value.detail.currentAttempt!.id,
    generation: 1,
    cancelRequested: false,
  };
  await open(page, value);
  let stops = 0;
  await page.route(`**/api/v1/tasks/${taskId}/attempts/attempt-5/stop`, async (route) => {
    stops++;
    value.detail.execution = 'cancelled';
    value.detail.currentAttempt!.status = 'cancelled';
    value.detail.workLock = null;
    value.detail.task.revision++;
    await route.fulfill({
      status: 202,
      json: { data: value.detail, meta: { requestId: 'stopped', replayed: false } },
    });
  });
  await page.getByRole('button', { name: '人工接管（停止当前工作）', exact: true }).click();
  const editor = page.getByLabel('人工编辑文案', { exact: true });
  await expect(editor).toHaveValue('第 5 次执行的文案');
  await editor.fill('正在编辑的人工文案');
  await page.getByRole('button', { name: '刷新详情', exact: true }).click();
  await expect(editor).toHaveValue('正在编辑的人工文案');
  expect(stops).toBe(1);
});
