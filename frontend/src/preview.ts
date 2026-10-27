import type { ActionAvailability, TaskAction, TaskDetail } from '@multi-agent-ops/shared';

export const scenarios = {
  draft: '待提交审核',
  ready: '审核通过 · 待批准',
  approved: '已批准 · 待发布',
  running: '执行中 · 只读',
  stopping: '停止待确认',
  reviewing: '人工审核中',
  blocked: '确定性阻断',
  conflict: '保存版本冲突',
  manual: '待人工发布',
  verification: '发布待核实',
  published: '已发布 · 只读',
  failed: '发布明确失败',
} as const;
export type Scenario = keyof typeof scenarios;
export const sampleBody =
  '把灵感变成日常。\n\n从一个小问题开始，给好奇心一点时间，让每一次尝试都有据可循。今天，你想探索什么？';
const date = '2026-10-27T07:30:00.000Z';
const hash = 'a'.repeat(64);
export function makePreviewTask(scene: Scenario = 'ready', id = 'task-demo'): TaskDetail {
  const work = ['running', 'stopping', 'reviewing'].includes(scene);
  const publishLock = ['manual', 'verification'].includes(scene);
  const published = scene === 'published';
  const approved = ['approved', 'manual', 'verification', 'published', 'failed'].includes(scene);
  const passed = scene === 'ready' || approved;
  const actions = Object.fromEntries(
    (
      [
        'save',
        'start',
        'stop',
        'terminate',
        'retry',
        'copy',
        'review',
        'approve',
        'publish',
        'backfill',
        'verify',
        'retry_publish',
        'reflect',
      ] satisfies TaskAction[]
    ).map((action) => [action, { allowed: false, reason: '当前状态不允许此操作' }]),
  ) as Record<TaskAction, ActionAvailability>;
  const allow = (...names: TaskAction[]) =>
    names.forEach((name) => {
      actions[name] = { allowed: true, reason: null };
    });
  if (!work && !publishLock && !published) allow('save', 'retry', 'terminate', 'reflect');
  if (!work && !publishLock) allow('reflect');
  if (!work && !publishLock && !published && !passed) allow('review');
  if (scene === 'ready' || scene === 'approved' || scene === 'failed') allow('approve');
  if (scene === 'approved') allow('publish');
  if (scene === 'running') allow('stop', 'terminate');
  if (scene === 'reviewing') allow('terminate');
  if (scene === 'manual') allow('backfill');
  if (scene === 'verification') allow('verify');
  if (scene === 'failed') allow('retry_publish');
  allow('copy');
  for (const name of ['save', 'retry', 'review', 'approve', 'publish'] satisfies TaskAction[]) {
    if (!actions[name].allowed)
      actions[name].reason = published
        ? '已发布任务只读，请复制为新任务'
        : publishLock
          ? '发布锁定，请先完成回填或核实'
          : work
            ? scene === 'stopping'
              ? '正在确认停止，编辑继续锁定'
              : '工作进行中，确认停止后才能操作'
            : name === 'publish'
              ? '先通过审核，再人工批准'
              : name === 'approve'
                ? '当前版本尚未通过审核，阻断不能绕过'
                : '当前状态不允许此操作';
  }
  const task: TaskDetail['task'] = {
    id,
    teamId: 'team-demo',
    accountId: 'account-demo',
    title:
      (
        {
          'task-running': '灵感周刊 · 日常探索',
          'task-verification': '周末提案 · 一条新动态',
          'task-published': '品牌日常 · 秋日计划',
        } as Record<string, string>
      )[id] ?? '秋日灵感计划 · 品牌日常文案',
    originalRequest:
      '面向年轻用户，写一条关于探索与日常灵感的微博。语气自然、有温度，不承诺未经证实的效果。',
    referenceInputs: [],
    clarifications: [],
    lifecycle: published ? 'published' : 'open',
    revision: scene === 'conflict' ? 13 : 12,
    currentAttemptId: 'attempt-demo',
    currentContentVersionId: 'version-3',
    currentReviewCycleId:
      passed || scene === 'blocked' || scene === 'reviewing' ? 'review-demo' : null,
    currentApprovalId: approved ? 'approval-demo' : null,
    activePublishOperationId: publishLock ? 'operation-demo' : null,
    publishedOperationId: published ? 'operation-demo' : null,
    sourceTaskId: null,
    createdBy: 'member-demo',
    createdAt: date,
    updatedAt: date,
    terminatedBy: null,
    terminatedAt: null,
    terminationReason: null,
  };
  const content: TaskDetail['currentContent'] = {
    id: 'version-3',
    taskId: id,
    originAttemptId: 'attempt-demo',
    parentVersionId: 'version-2',
    versionNo: 3,
    body: sampleBody,
    contentHash: hash,
    sourceKind: 'manual',
    revisionRoundId: null,
    sourceRefs: [],
    usedMemoryRefs: [],
    createdBy: 'member-demo',
    createdAt: date,
  };
  const publication: TaskDetail['publication'] =
    scene === 'manual'
      ? 'awaiting_manual'
      : scene === 'verification'
        ? 'verification_required'
        : published
          ? 'published'
          : scene === 'failed'
            ? 'failed'
            : 'not_published';
  return {
    task,
    execution: work && scene !== 'reviewing' ? 'running' : 'ready',
    approval: approved ? 'approved' : passed ? 'pending' : 'invalidated',
    publication,
    reflection: 'not_triggered',
    currentStep: work ? 'research' : null,
    currentAttempt: {
      id: 'attempt-demo',
      taskId: id,
      attemptNo: 1,
      status: work && scene !== 'reviewing' ? 'running' : 'ready',
      currentStep: work ? 'research' : null,
      autoRevisionCount: 2,
      configVersion: 4,
      requestedBy: 'member-demo',
      createdAt: date,
      cancelScope: scene === 'stopping' ? 'stop_attempt' : null,
      cancelRequestedAt: scene === 'stopping' ? date : null,
      cancelRequestedBy: scene === 'stopping' ? 'member-demo' : null,
      cancelReason: scene === 'stopping' ? '停止后人工编辑' : null,
      stoppedAt: null,
      startedAt: date,
      finishedAt: work ? null : date,
      error: null,
      traceUrl: null,
    },
    currentContent: content,
    currentReview: task.currentReviewCycleId
      ? {
          id: 'review-demo',
          taskId: id,
          attemptId: 'attempt-demo',
          trigger: 'manual_submit',
          inputVersionId: 'version-3',
          currentVersionId: 'version-3',
          status: scene === 'reviewing' ? 'running' : 'completed',
          records: [
            {
              id: 'record-demo',
              cycleId: 'review-demo',
              contentVersionId: 'version-3',
              outcome: scene === 'blocked' ? 'changes_required' : 'pass',
              checks: ['账号规则', '事实来源', '文案格式'],
              blockingIssues:
                scene === 'blocked'
                  ? [
                      {
                        id: 'issue-demo',
                        kind: 'deterministic',
                        message: '文案违反已配置的平台格式规则，需要修改并重新审核。',
                        resolved: false,
                      },
                    ]
                  : [],
              scores: [{ name: '任务符合度', value: 4, source: 'model' }],
              sourceRefs: [],
              createdAt: date,
            },
          ],
          requestedBy: 'member-demo',
          configVersion: 4,
          createdAt: date,
          finishedAt: scene === 'reviewing' ? null : date,
          error: null,
        }
      : null,
    currentApproval: approved
      ? {
          id: 'approval-demo',
          taskId: id,
          contentVersionId: 'version-3',
          contentHash: hash,
          accountId: 'account-demo',
          reviewCycleId: 'review-demo',
          status: 'approved',
          approvedBy: 'member-demo',
          approvedAt: date,
          invalidatedAt: null,
          invalidatedReason: null,
        }
      : null,
    currentPublication:
      publication !== 'not_published'
        ? {
            id: 'operation-demo',
            taskId: id,
            contentVersionId: 'version-3',
            contentHash: hash,
            accountId: 'account-demo',
            status: publication,
            currentDispatchId: 'dispatch-1',
            dispatches: [
              {
                id: 'dispatch-1',
                operationId: 'operation-demo',
                dispatchNo: 1,
                approvalId: 'approval-demo',
                channel: scene === 'manual' ? 'manual' : 'official_api',
                status: publication,
                startedBy: 'member-demo',
                startedAt: date,
                finishedAt: null,
                providerRequestId: null,
                platformPostId: null,
                url: null,
                error:
                  scene === 'verification'
                    ? {
                        code: 'RECEIPT_TIMEOUT',
                        message: '发送后未获得明确回执，结果未知',
                        retryable: false,
                      }
                    : null,
              },
            ],
            verifications: [],
            createdBy: 'member-demo',
            createdAt: date,
            updatedAt: date,
          }
        : null,
    latestReflection: null,
    workLock: work
      ? {
          ownerType: scene === 'reviewing' ? 'manual_review' : 'attempt',
          ownerId: scene === 'reviewing' ? 'review-demo' : 'attempt-demo',
          generation: 1,
          cancelRequested: scene === 'stopping',
        }
      : null,
    actions,
    account: {
      id: 'account-demo',
      displayName: '品牌官方微博',
      platform: 'weibo',
      authorizationStatus: 'valid',
      officialPublishAvailable: false,
    },
  };
}
export const previewTasks = [
  makePreviewTask('ready'),
  makePreviewTask('running', 'task-running'),
  makePreviewTask('verification', 'task-verification'),
  makePreviewTask('published', 'task-published'),
];
export const executionLabels = {
  awaiting_clarification: '待澄清',
  queued: '排队中',
  running: '执行中',
  manual_required: '待人工处理',
  ready: '产出就绪',
  failed: '执行失败',
  cancelled: '已取消',
};
export const approvalLabels = {
  not_requested: '未申请',
  pending: '待批准',
  approved: '已批准',
  invalidated: '已失效',
};
export const publicationLabels = {
  not_published: '未发布',
  awaiting_manual: '待人工发布',
  publishing: '发布中',
  verification_required: '发布待核实',
  published: '已发布',
  failed: '发布失败',
};
