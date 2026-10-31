import type { Role } from './domain.js';
import type { ErrorCode } from './api.js';
import type { ResponseModels } from './responses.js';
import { responseSchemas } from './generated/response-schemas.js';

export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  pattern?: string;
  description?: string;
};
const text = (maxLength = 2000, minLength = 1): Schema => ({
  type: 'string',
  minLength,
  maxLength,
});
const id: Schema = { ...text(128), pattern: '^[A-Za-z0-9_-]+$' };
const nullableId: Schema = { ...id, type: ['string', 'null'] };
const integer: Schema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const bool: Schema = { type: 'boolean' };
const list = (items: Schema, minItems = 0): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems: 100,
});
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', additionalProperties: false, properties, required });
const ids = list(id);
const revision = { expectedRevision: integer };
const version = { ...revision, contentVersionId: id };
const publish = {
  ...version,
  accountId: id,
  approvalId: id,
  contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  channel: choice('official_api', 'manual'),
};
const page = { cursor: text(512), limit: { type: 'integer', minimum: 1, maximum: 100 } };
const reason = text(2000);
const read = object(page, []);
const input = (fields: Record<string, Schema>, required?: string[]) => object(fields, required);
const both: readonly Role[] = ['admin', 'operator'];
const admins: readonly Role[] = ['admin'];
const errors: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'WORK_LOCKED',
  'PUBLICATION_LOCKED',
  'INVALID_STATE',
  'REVIEW_BLOCKED',
  'APPROVAL_INVALID',
  'ACCOUNT_UNAUTHORIZED',
  'RESULT_UNKNOWN',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
  'NOT_IMPLEMENTED',
];
export interface Endpoint {
  operationId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  roles: readonly Role[];
  body?: Schema;
  query?: Schema;
  response: keyof ResponseModels;
  success: 200 | 201 | 202;
  conditions: string;
  transitions: string[];
  audit: string;
  ac: string[];
  repetition: string;
  errors: readonly ErrorCode[];
}
type Definition = Omit<Endpoint, 'success' | 'roles' | 'errors' | 'repetition'> &
  Partial<Pick<Endpoint, 'success' | 'roles' | 'repetition'>>;
const endpoint = (d: Definition): Endpoint => ({
  success: d.method === 'GET' ? 200 : 202,
  roles: both,
  errors,
  repetition:
    d.method === 'GET'
      ? '只读，可重试；分页使用不透明游标。'
      : '须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。',
  ...d,
});
const taskRules = '同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。';
const publishRules = `${taskRules}当前版本、摘要、账号、审核、批准均匹配，账号授权有效，无历史成功发布。`;
const verification = input(
  {
    ...version,
    dispatchId: id,
    accountId: id,
    conclusion: choice('published', 'not_published', 'unknown'),
    platformPostId: text(128),
    url: { ...text(2048), format: 'uri' },
    observedContentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    evidenceIds: list(id, 1),
    note: reason,
    previousDispatchFenced: bool,
  },
  [
    'expectedRevision',
    'contentVersionId',
    'dispatchId',
    'accountId',
    'conclusion',
    'evidenceIds',
    'note',
  ],
);

/** Live manual editorial and mock execution routes coexist with explicitly marked contract-only routes. */
export const endpoints: readonly Endpoint[] = [
  endpoint({
    operationId: 'login',
    method: 'POST',
    path: '/auth/login',
    summary: '成员登录',
    roles: [],
    body: input({ login: text(254), password: text(256, 8) }),
    response: 'Session',
    success: 200,
    conditions:
      '内部成员口令登录；成员 active；统一凭据错误，账号/IP 持久限流；可信 Origin；成功设置 HttpOnly 会话 Cookie，绝对有效 8 小时。',
    transitions: [],
    audit: 'auth.login（不含口令）',
    ac: ['AC-08'],
    repetition:
      '须 Idempotency-Key；凭据仍有效时同键同请求复用原会话，权限反映当前成员角色；同键不同请求 409；已退出、过期或撤销的会话不复活。重放材料仅加密持久化。',
  }),
  endpoint({
    operationId: 'logout',
    method: 'POST',
    path: '/auth/logout',
    summary: '退出并撤销当前会话',
    response: 'Logout',
    success: 200,
    conditions: '允许会话已过期；校验同源，已有会话须 CSRF。',
    transitions: [],
    audit: 'auth.logout',
    ac: ['AC-08'],
    repetition: '重复退出返回 signedOut=true；清除 Cookie。',
  }),
  endpoint({
    operationId: 'getMe',
    method: 'GET',
    path: '/auth/me',
    summary: '当前成员与权限',
    response: 'Session',
    conditions: '有效会话；禁用成员的会话立即失效。',
    transitions: [],
    audit: '安全访问日志',
    ac: ['AC-08'],
  }),
  endpoint({
    operationId: 'listMembers',
    method: 'GET',
    path: '/members',
    summary: '查询团队成员',
    roles: admins,
    query: read,
    response: 'Members',
    conditions: '仅管理员；不返回凭据。',
    transitions: [],
    audit: '安全访问日志',
    ac: ['AC-08'],
  }),
  endpoint({
    operationId: 'updateMember',
    method: 'PATCH',
    path: '/members/:memberId',
    summary: '修改成员角色或状态',
    roles: admins,
    body: input({
      expectedVersion: integer,
      role: choice('admin', 'operator'),
      status: choice('active', 'disabled'),
    }),
    response: 'Member',
    success: 200,
    conditions: '比较成员版本；不能禁用或降级最后一名 active 管理员；禁用立即撤销会话。',
    transitions: [],
    audit: 'member.updated',
    ac: ['AC-08'],
  }),
  endpoint({
    operationId: 'getAccount',
    method: 'GET',
    path: '/accounts/:accountId',
    summary: '账号及授权摘要',
    response: 'Account',
    conditions: '同团队固定账号；不返回令牌。',
    transitions: [],
    audit: '安全访问日志',
    ac: ['AC-08', 'AC-14'],
  }),
  endpoint({
    operationId: 'authorizeAccount',
    method: 'POST',
    path: '/accounts/:accountId/authorization-sessions',
    summary: '创建官方账号授权会话',
    roles: admins,
    response: 'AuthorizationSession',
    conditions:
      '仅管理员；官方授权 URL 白名单、短期 state、防 CSRF；不接收或返回明文密钥。授权回调实现留到集成阶段。',
    transitions: [],
    audit: 'account.authorization_requested',
    ac: ['AC-08', 'AC-14'],
  }),
  endpoint({
    operationId: 'createTask',
    method: 'POST',
    path: '/tasks',
    summary: '创建草稿任务，不自动执行',
    body: input(
      {
        title: text(120),
        originalRequest: text(10000),
        referenceInputs: list(input({ label: text(200), url: { ...text(2048), format: 'uri' } })),
      },
      ['title', 'originalRequest'],
    ),
    response: 'TaskDetail',
    success: 201,
    conditions:
      '团队已配置唯一账号时由服务端绑定；未配置时允许先保存草稿，accountId 和 account 为 null，后续绑定；标题和原始要求不能仅含空白，原文保留；revision=1、lifecycle=open；所有当前引用为空，不创建执行尝试。',
    transitions: ['A01'],
    audit: 'task.created',
    ac: ['AC-01'],
  }),
  endpoint({
    operationId: 'listTasks',
    method: 'GET',
    path: '/tasks',
    summary: '分页查询任务及四维状态',
    query: input(
      {
        ...page,
        q: text(120),
        lifecycle: choice('open', 'terminated', 'published'),
        execution: choice(
          'awaiting_clarification',
          'queued',
          'running',
          'manual_required',
          'ready',
          'failed',
          'cancelled',
        ),
        approval: choice('not_requested', 'pending', 'approved', 'invalidated'),
        publication: choice(
          'not_published',
          'awaiting_manual',
          'publishing',
          'verification_required',
          'published',
          'failed',
        ),
      },
      [],
    ),
    response: 'Tasks',
    conditions: '同团队；筛选 AND 组合；updatedAt DESC,id DESC 稳定游标。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-01', 'AC-10'],
  }),
  endpoint({
    operationId: 'getTask',
    method: 'GET',
    path: '/tasks/:taskId',
    summary: '任务详情、锁与操作资格',
    response: 'TaskDetail',
    conditions:
      '同团队成员可查看；一次一致性快照读取任务和绑定账号摘要，未绑定账号正常返回 null；返回当前步骤和 errorMessage；不存在或跨团队统一 404；历史创建人缺失或账号跨团队错绑返回 409 INVALID_STATE；actions 是服务端建议，每次写入仍须重校验。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-01', 'AC-10'],
  }),
  endpoint({
    operationId: 'taskHistory',
    method: 'GET',
    path: '/tasks/:taskId/history',
    summary: '执行步骤、尝试与审计',
    query: read,
    response: 'History',
    conditions:
      '同团队；cursor 仅作用于 audit；每任务最多 100 次完整尝试，attempts/steps 及 clarificationAnswers 完整返回；包含模拟模式标识，不含配置快照、内部推理或凭据。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-03', 'AC-10', 'AC-11'],
  }),
  endpoint({
    operationId: 'clarifyTask',
    method: 'POST',
    path: '/tasks/:taskId/clarifications',
    summary: '答复当前尝试的澄清问题',
    body: input({
      ...revision,
      attemptId: id,
      answers: list(input({ questionId: id, answer: text(4000) }), 1),
    }),
    response: 'TaskDetail',
    conditions:
      '同团队、任务 open、当前模拟 attempt=awaiting_clarification，无取消意图；原子比较 expectedRevision 与 attemptId；仅接受当前未答问题的非空答复，追加记录答复人和时间，不覆盖历史；部分答复保持待澄清，全部答复后继续同一次尝试，保留原始输入和已完成步骤；当前不进行语义充分性或冲突判断。',
    transitions: ['E02', 'E03'],
    audit: 'task.clarified',
    ac: ['AC-02'],
  }),
  endpoint({
    operationId: 'startTask',
    method: 'POST',
    path: '/tasks/:taskId/attempts',
    summary: '首次启动完整执行',
    body: input(
      { ...revision, simulationScenario: choice('success', 'failure', 'clarification') },
      ['expectedRevision'],
    ),
    response: 'TaskDetail',
    conditions: `${taskRules}尚无完整尝试且无遗留执行状态；D4 仅模拟执行，无账号也可验证；simulationScenario 默认 success，可选 failure/clarification；输入及模拟器 v1 配置冻结，计数=0；创建 queued 尝试和步骤，清空当前产出。`,
    transitions: ['E01', 'A05'],
    audit: 'attempt.started',
    ac: ['AC-01', 'AC-03', 'AC-05'],
  }),
  endpoint({
    operationId: 'stopAttempt',
    method: 'POST',
    path: '/tasks/:taskId/attempts/:attemptId/stop',
    summary: '停止本次执行以便编辑',
    body: input({ ...revision, reason }),
    response: 'TaskDetail',
    conditions:
      '当前模拟尝试待澄清/queued/running，任务 open；模拟执行无外部调用，在同一事务记录取消、隔离旧 generation 并确认停止后解锁；任务仍 open。真实执行的异步停止尚未实现。',
    transitions: ['E10', 'E11', 'E12'],
    audit: 'attempt.stop_requested / attempt.stopped',
    ac: ['AC-07'],
  }),
  endpoint({
    operationId: 'retryTask',
    method: 'POST',
    path: '/tasks/:taskId/attempt-retries',
    summary: '重新执行或显式重启已终止任务',
    body: input(
      {
        ...revision,
        previousAttemptId: nullableId,
        restartTerminated: bool,
        reason,
        simulationScenario: choice('success', 'failure', 'clarification'),
      },
      ['expectedRevision', 'previousAttemptId', 'restartTerminated', 'reason'],
    ),
    response: 'TaskDetail',
    conditions:
      'D4 仅开放任务的模拟重试，restartTerminated 必须 false；previousAttemptId 匹配当前已结束尝试，无工作槽；新 attemptNo，从头执行并保留旧记录；simulationScenario 默认 success，可选 failure/clarification；已终止任务的重启后续实现。',
    transitions: ['E13', 'A05'],
    audit: 'attempt.retried / task.reopened',
    ac: ['AC-03', 'AC-05', 'AC-07'],
  }),
  endpoint({
    operationId: 'terminateTask',
    method: 'POST',
    path: '/tasks/:taskId/terminate',
    summary: '终止任务并阻止后续发布',
    body: input({ ...revision, reason }),
    response: 'TaskDetail',
    conditions:
      '未发布且无发布锁；允许运行工作存在，原子置 terminated、失效批准并取消所有工作；停止未确认仍保留工作槽。',
    transitions: ['E10', 'E11', 'E12', 'C08', 'A06'],
    audit: 'task.terminated',
    ac: ['AC-07'],
  }),
  endpoint({
    operationId: 'copyTask',
    method: 'POST',
    path: '/tasks/:taskId/copies',
    summary: '复制为新任务',
    body: input({
      ...revision,
      sourceContentVersionId: nullableId,
      title: text(120),
    }),
    response: 'TaskDetail',
    success: 201,
    conditions:
      '任意可读任务；快照 revision；指定来源版必须属于原任务；新任务 sourceTaskId，复制文案为新 manual V1，审核/批准/发布引用均空；不自动执行。',
    transitions: ['P15', 'A01'],
    audit: 'task.copied',
    ac: ['AC-01', 'AC-06'],
  }),
  endpoint({
    operationId: 'listContent',
    method: 'GET',
    path: '/tasks/:taskId/content-versions',
    summary: '内容版本历史',
    query: read,
    response: 'ContentVersions',
    conditions: '同任务；versionNo DESC；不可变内容。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-05', 'AC-10'],
  }),
  endpoint({
    operationId: 'getContent',
    method: 'GET',
    path: '/tasks/:taskId/content-versions/:versionId',
    summary: '读取某个不可变版本',
    response: 'ContentVersion',
    conditions: '版本属于路径任务及团队。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-05', 'AC-10'],
  }),
  endpoint({
    operationId: 'compareContent',
    method: 'GET',
    path: '/tasks/:taskId/content-comparison',
    summary: '比较两个已保存版本',
    query: input({ fromVersionId: id, toVersionId: id }),
    response: 'CompareVersions',
    conditions: '两版本同任务；未保存的用户输入只在客户端本地比较。',
    transitions: ['C03'],
    audit: '访问日志',
    ac: ['AC-05'],
  }),
  endpoint({
    operationId: 'saveContent',
    method: 'POST',
    path: '/tasks/:taskId/content-versions',
    summary: '保存新内容版本，不自动审核',
    body: input({
      ...revision,
      baseContentVersionId: nullableId,
      body: text(20000),
    }),
    response: 'SaveContent',
    success: 201,
    conditions: `${taskRules}同时比较当前版本 ID（首次为 null）；正文非全空，不 trim 或归一化实际发送正文；格式问题允许保存，但阻断审核/批准/发布。`,
    transitions: ['C02', 'C03', 'A05'],
    audit: 'content.saved / approval.invalidated',
    ac: ['AC-04', 'AC-05'],
  }),
  endpoint({
    operationId: 'submitReview',
    method: 'POST',
    path: '/tasks/:taskId/reviews',
    summary: '手动提交当前版本审核',
    body: input({ ...version, subjectiveNote: text(2000, 0) }, Object.keys(version)),
    response: 'Review',
    conditions: `${taskRules}当前人工版；同步检查字符数、纯文案与当前禁止词，可附加 subjectiveNote 记录人工主观意见；冻结版本与配置，只审核不重写、不调用 Agent；同键同请求重放原结果。`,
    transitions: ['C04', 'C10'],
    audit: 'review.submitted',
    ac: ['AC-03', 'AC-04', 'AC-05'],
  }),
  endpoint({
    operationId: 'listReviews',
    method: 'GET',
    path: '/tasks/:taskId/reviews',
    summary: '审核周期历史',
    query: read,
    response: 'Reviews',
    conditions: '同任务；completed 与 pass 独立。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-04', 'AC-10'],
  }),
  endpoint({
    operationId: 'getReview',
    method: 'GET',
    path: '/tasks/:taskId/reviews/:reviewId',
    summary: '审核结果、阻断与评分来源',
    response: 'Review',
    conditions: '同任务；记录冻结目标版本；事实不足不按模型高分放行。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-03', 'AC-04', 'AC-10'],
  }),
  endpoint({
    operationId: 'stopReview',
    method: 'POST',
    path: '/tasks/:taskId/reviews/:reviewId/stop',
    summary: '取消人工审核',
    body: input({ ...revision, reason }),
    response: 'TaskDetail',
    conditions:
      '当前 manual_submit 周期 queued/running；无发布锁；停止/隔离确认前保持槽；不取消历史已完成周期。',
    transitions: ['C08'],
    audit: 'review.stop_requested / review.cancelled',
    ac: ['AC-07'],
  }),
  endpoint({
    operationId: 'decideReview',
    method: 'POST',
    path: '/tasks/:taskId/reviews/:reviewId/decisions',
    summary: '人工裁决主观分歧',
    body: input({
      ...version,
      reviewRecordId: id,
      reason,
      acceptedIssues: ids,
      unresolvedIssues: ids,
      evidenceIds: ids,
    }),
    response: 'Decision',
    success: 201,
    conditions: `${taskRules}当前已完成审核；仅裁决 subjective；accepted/unresolved 必须互斥且覆盖待裁决项；确定性阻断仍拒绝，事实不足先补证/修改重审；追加决定，不改旧 ReviewRecord。`,
    transitions: ['A02', 'A07'],
    audit: 'review.decided',
    ac: ['AC-04'],
  }),
  endpoint({
    operationId: 'listDecisions',
    method: 'GET',
    path: '/tasks/:taskId/reviews/:reviewId/decisions',
    summary: '读取人工裁决历史',
    query: read,
    response: 'Decisions',
    conditions: '同团队同任务，保留所有不可变裁决及理由。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-04'],
  }),
  endpoint({
    operationId: 'approveContent',
    method: 'POST',
    path: '/tasks/:taskId/approvals',
    summary: '批准指定版本，等待用户点击发布',
    body: input({
      ...version,
      reviewCycleId: id,
      accountId: id,
      contentHash: publish.contentHash!,
    }),
    response: 'ApprovalResult',
    success: 201,
    conditions: `${taskRules}审核 pass 或合法主观裁决；无未解决阻断；允许批准自己的文案；同版本有效批准已存在则 200 返回已有批准。`,
    transitions: ['A03', 'A04', 'A07'],
    audit: 'approval.created / approval.replayed',
    ac: ['AC-04', 'AC-05', 'AC-08'],
  }),
  endpoint({
    operationId: 'publishContent',
    method: 'POST',
    path: '/tasks/:taskId/publications',
    summary: '点击发布或创建人工交接',
    body: input(publish),
    response: 'Publication',
    conditions: `${publishRules}当前仅接入旧批准和版本不匹配的拒绝校验；有效请求仍返回 501，不创建发送记录或对外发布。后续官方渠道须 officialPublishAvailable。`,
    transitions: ['P01', 'P02', 'P13'],
    audit: 'publication.requested / publication.handed_off',
    ac: ['AC-01', 'AC-06', 'AC-08', 'AC-14'],
    repetition:
      '无论 HTTP 键是否相同，同版本同账号复用稳定 operationId；待人工/发布中/待核实或已成功只返回原操作，不增 dispatch；failed 返回原失败，仅专用 retries 可新增发送。',
  }),
  endpoint({
    operationId: 'listPublications',
    method: 'GET',
    path: '/tasks/:taskId/publications',
    summary: '发布操作历史',
    query: read,
    response: 'Publications',
    conditions: '同任务；包含旧版本操作，不改绑新版本。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-06', 'AC-10', 'AC-11'],
  }),
  endpoint({
    operationId: 'getPublication',
    method: 'GET',
    path: '/tasks/:taskId/publications/:operationId',
    summary: '读取稳定发布操作、发送及核实证据',
    response: 'Publication',
    conditions: '同任务；HTTP 超时后优先读取本操作或列表；读失败不释放锁。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-06', 'AC-11'],
  }),
  endpoint({
    operationId: 'backfillPublication',
    method: 'POST',
    path: '/tasks/:taskId/publications/:operationId/backfills',
    summary: '人工交接回填或明确未发送',
    body: verification,
    response: 'Publication',
    conditions:
      'awaiting_manual；dispatchId 为当前人工交接；版本/账号匹配；published 必须平台 ID/链接/实际摘要匹配；不匹配或不确定进入待核实；not_published 须可靠未发送声明并 previousDispatchFenced=true。',
    transitions: ['P06', 'P07', 'P08', 'P14'],
    audit: 'publication.backfilled',
    ac: ['AC-01', 'AC-06', 'AC-07'],
  }),
  endpoint({
    operationId: 'verifyPublication',
    method: 'POST',
    path: '/tasks/:taskId/publications/:operationId/verifications',
    summary: '追加人工核实，不发送文案',
    body: verification,
    response: 'Publication',
    conditions:
      'verification_required；证据必须归属本发送；成功须账号/版本/摘要匹配；not_published 必须有前次不会再生效的证据及 previousDispatchFenced=true；unknown/差异继续锁定；method 由此端点记为 manual，不接受客户端声称 official_query。',
    transitions: ['P09', 'P10', 'P11', 'P14'],
    audit: 'publication.verified',
    ac: ['AC-06', 'AC-07', 'AC-11', 'AC-14'],
  }),
  endpoint({
    operationId: 'retryPublication',
    method: 'POST',
    path: '/tasks/:taskId/publications/:operationId/retries',
    summary: '明确失败后的人工重试',
    body: input({ ...publish, previousDispatchId: id, reason }),
    response: 'Publication',
    conditions: `${publishRules}操作为 failed，前次有可靠未发布证据且不会迟到生效；previousDispatchId 匹配；同 operationId 增 dispatchNo；绝不自动重发。`,
    transitions: ['P12'],
    audit: 'publication.retry_requested',
    ac: ['AC-06', 'AC-07', 'AC-14'],
  }),
  endpoint({
    operationId: 'listMemories',
    method: 'GET',
    path: '/memories',
    summary: '按类型、用途、状态查询记忆',
    query: input(
      {
        ...page,
        accountId: id,
        purpose: choice('creation', 'reflection', 'experiment', 'management'),
        type: choice('account_preference', 'task_fact', 'candidate', 'confirmed_experience'),
        status: choice('active', 'disabled', 'deleted'),
      },
      ['accountId', 'purpose'],
    ),
    response: 'Memories',
    conditions:
      '服务端团队隔离；creation 仅 active 非候选且范围适用，冲突用途筛选返回 422；每次按业务库当前版本复核；deleted 仅 management 返回无正文 tombstone。',
    transitions: [],
    audit: 'memory.queried（仅记录用途/引用）',
    ac: ['AC-09', 'AC-10'],
  }),
  endpoint({
    operationId: 'getMemory',
    method: 'GET',
    path: '/memories/:memoryId',
    summary: '记忆详情与来源',
    response: 'Memory',
    conditions: '同团队；已删除返回 tombstone、body=null，无恢复操作。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'editMemory',
    method: 'PATCH',
    path: '/memories/:memoryId',
    summary: '编辑记忆，创建新业务版本',
    body: input({ expectedVersion: integer, body: text(10000), scope: text(1000), reason }),
    response: 'MemoryMutation',
    success: 200,
    conditions:
      'active/disabled；版本匹配；不允许直接改 type/确认信息；编辑不改变候选类型或自动创建正式策略；已确认经验范围不得超出已有人工确认范围；旧索引版本不能召回。',
    transitions: ['M05'],
    audit: 'memory.edited',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'setMemoryAvailability',
    method: 'POST',
    path: '/memories/:memoryId/availability',
    summary: '明确禁用或启用记忆',
    body: input({ expectedVersion: integer, status: choice('active', 'disabled'), reason }),
    response: 'MemoryMutation',
    success: 200,
    conditions:
      '未 deleted；匹配版本；立即按新可用性过滤；启用不升级候选；同状态返回原对象不建多余同步。',
    transitions: ['M03', 'M04'],
    audit: 'memory.availability_changed',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'deleteMemory',
    method: 'DELETE',
    path: '/memories/:memoryId',
    summary: '删除记忆并立即停止召回',
    body: input({ expectedVersion: integer, confirmed: { type: 'boolean', enum: [true] }, reason }),
    response: 'MemoryMutation',
    success: 200,
    conditions:
      '人工确认且版本匹配；原子 tombstone + 清理意图，立即 body=null、阻断召回；无回收站。相同幂等请求重放；已删除的新请求返回 tombstone 与原清理任务。',
    transitions: ['M06'],
    audit: 'memory.deleted（无正文）',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'confirmMemory',
    method: 'POST',
    path: '/memories/:memoryId/confirmations',
    summary: '人工确认候选，创建独立已确认经验',
    body: input({ expectedVersion: integer, reason, scope: text(1000), evidenceIds: list(id, 1) }),
    response: 'ConfirmedMemory',
    success: 201,
    conditions:
      '候选 active；证据/范围明确；保留原候选，以(sourceCandidateId,candidateVersion)防重；不自动更改正式配置。',
    transitions: ['M02'],
    audit: 'memory.confirmed',
    ac: ['AC-09', 'AC-12'],
  }),
  endpoint({
    operationId: 'listMemorySync',
    method: 'GET',
    path: '/memories/:memoryId/sync-jobs',
    summary: '受管同步/清理状态与失败范围',
    query: read,
    response: 'SyncJobs',
    conditions: 'deleted 也可查；失败可见；不宣称外部所有历史已清除。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'retryMemorySync',
    method: 'POST',
    path: '/memories/:memoryId/sync-jobs/:jobId/retry',
    summary: '重试失败的同步/清理',
    body: input({ expectedVersion: integer }),
    response: 'SyncJob',
    conditions:
      'job failed 且 targetVersion=当前版本；复用 job，attemptCount 增加；旧版本 409，不复活已删除内容。',
    transitions: ['M09'],
    audit: 'memory.sync_retried',
    ac: ['AC-09'],
  }),
  endpoint({
    operationId: 'createReflection',
    method: 'POST',
    path: '/tasks/:taskId/reflections',
    summary: '手动触发复盘',
    body: input({
      ...revision,
      contentVersionId: nullableId,
      attemptId: id,
      evidenceIds: list(id, 1),
    }),
    response: 'Reflection',
    conditions:
      '尝试已结束；无工作槽、未决发布或同任务 processing 复盘；允许 terminated/published；冻结所选尝试的版本及证据，产出前失败时 contentVersionId 显式 null 并引用失败证据；不占用发布资格。',
    transitions: ['F01'],
    audit: 'reflection.requested',
    ac: ['AC-12'],
  }),
  endpoint({
    operationId: 'listReflections',
    method: 'GET',
    path: '/tasks/:taskId/reflections',
    summary: '复盘历史',
    query: read,
    response: 'Reflections',
    conditions: '同任务；新复盘不覆盖旧结论。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-12'],
  }),
  endpoint({
    operationId: 'getReflection',
    method: 'GET',
    path: '/tasks/:taskId/reflections/:reflectionId',
    summary: '证据、观察、假设与不确定性',
    response: 'Reflection',
    conditions: '同任务；明确区分证据与推测。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-10', 'AC-12'],
  }),
  endpoint({
    operationId: 'retryReflection',
    method: 'POST',
    path: '/tasks/:taskId/reflections/:reflectionId/retries',
    summary: '再次复盘，新建关联记录',
    body: input({ ...revision, contentVersionId: nullableId, evidenceIds: list(id, 1) }),
    response: 'Reflection',
    conditions: '旧复盘 failed/completed；满足 F01；新记录 retryOfReflectionId；无同任务并行复盘。',
    transitions: ['F04'],
    audit: 'reflection.retried',
    ac: ['AC-12'],
  }),
  endpoint({
    operationId: 'saveCandidate',
    method: 'POST',
    path: '/tasks/:taskId/reflections/:reflectionId/candidates',
    summary: '把复盘建议保存为候选经验',
    body: input({ suggestionId: id }),
    response: 'Memory',
    success: 201,
    conditions:
      '复盘 completed、建议属于本复盘；冻结原建议/证据/不确定性；唯一(reflectionId,suggestionId)；不创建正式策略。',
    transitions: ['F05', 'M01'],
    audit: 'memory.candidate_saved',
    ac: ['AC-09', 'AC-12'],
  }),
  endpoint({
    operationId: 'getConfig',
    method: 'GET',
    path: '/config',
    summary: '读取无密钥配置及版本',
    roles: admins,
    response: 'Config',
    conditions: '仅管理员；不含凭据；maxAutoRevisions 固定 3。',
    transitions: [],
    audit: 'config.read',
    ac: ['AC-08', 'AC-10'],
  }),
  endpoint({
    operationId: 'updateConfig',
    method: 'PUT',
    path: '/config',
    summary: '保存完整配置新版本',
    roles: admins,
    body: input({
      expectedVersion: integer,
      profile: text(4000),
      tone: text(1000),
      forbiddenTopics: list(text(500)),
      rules: list(input({ id, description: text(1000), deterministic: bool })),
      modelRef: text(128),
      promptVersion: text(128),
      toolVersion: text(128),
      reason,
    }),
    response: 'Config',
    success: 200,
    conditions:
      '仅管理员，版本匹配，服务端追加版本；运行尝试保留快照；基础规则变化须重验现有审核/批准，不满足则 A06，发布入口使用当前规则。',
    transitions: ['A06'],
    audit: 'config.updated',
    ac: ['AC-05', 'AC-08', 'AC-10'],
  }),
  endpoint({
    operationId: 'listExperiments',
    method: 'GET',
    path: '/experiments',
    summary: '离线实验摘要',
    query: read,
    response: 'Experiments',
    conditions: '同团队；含失败样本/成本/限制；不推定多 Agent 必胜。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-13'],
  }),
  endpoint({
    operationId: 'runExperiment',
    method: 'POST',
    path: '/experiments',
    summary: '运行已配置离线实验',
    body: input({
      configVersion: integer,
      datasetVersion: text(128),
      offline: { type: 'boolean', enum: [true] },
    }),
    response: 'Experiment',
    conditions:
      '冻结配置与数据集；独立实验执行上下文，无真实发布凭据/工具；结果仅 SimulationRecord，不能改实际任务发布状态。',
    transitions: [],
    audit: 'experiment.requested',
    ac: ['AC-13'],
  }),
  endpoint({
    operationId: 'getExperiment',
    method: 'GET',
    path: '/experiments/:experimentId',
    summary: '实验摘要及 Langfuse 链接',
    response: 'Experiment',
    conditions: '同团队；外链权限由 Langfuse 独立管理；盲评前不暴露分组信息。',
    transitions: [],
    audit: '访问日志',
    ac: ['AC-10', 'AC-11', 'AC-13'],
  }),
  endpoint({
    operationId: 'nextBlindItem',
    method: 'GET',
    path: '/experiments/:experimentId/blind-items/next',
    summary: '读取当前成员未评分的匿名样本',
    response: 'BlindItem',
    conditions:
      '实验有可评样本；按成员固定随机顺序计算下一未评分项，GET 不写分配状态；分组/模型/策略/轨迹隐藏；同一未提交样本重复读取相同。',
    transitions: [],
    audit: 'evaluation.item_viewed',
    ac: ['AC-13'],
  }),
  endpoint({
    operationId: 'submitBlindScore',
    method: 'POST',
    path: '/experiments/:experimentId/blind-scores',
    summary: '提交人工盲评',
    body: input({
      itemId: id,
      expectedVersion: integer,
      choiceId: id,
      score: { type: 'integer', minimum: 1, maximum: 5 },
      reason,
    }),
    response: 'BlindScore',
    success: 201,
    conditions:
      '样本归属本成员会话，choice 属于 item；唯一(memberId,itemId)，不能用新请求覆盖旧分；版本冲突 409。',
    transitions: [],
    audit: 'evaluation.scored',
    ac: ['AC-13'],
  }),
];

export function getOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of endpoints) {
    const path = `/api/v1${e.path.replace(/:([A-Za-z]+)/g, '{$1}')}`;
    const parameters: Record<string, unknown>[] = [...e.path.matchAll(/:([A-Za-z]+)/g)].map(
      (m) => ({ name: m[1], in: 'path', required: true, schema: id }),
    );
    if (e.query?.properties)
      for (const [name, schema] of Object.entries(e.query.properties))
        parameters.push({
          name,
          in: 'query',
          required: e.query.required?.includes(name) ?? false,
          schema,
        });
    if (e.method !== 'GET')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: e.operationId !== 'logout',
        schema: { type: 'string', minLength: 16, maxLength: 128 },
        description: '稳定用户动作标识；同一动作重传复用；与稳定发布 operationId 不同。',
      });
    if (e.method !== 'GET' && e.operationId !== 'login')
      parameters.push({
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: text(256),
        description: '取自 /auth/me，与会话绑定。',
      });
    const response = {
      description: ['login', 'getMe', 'logout'].includes(e.operationId)
        ? 'D3 认证接口成功响应；需要配置业务数据库和认证密钥。'
        : e.operationId === 'createTask'
          ? 'D4 创建任务成功响应；任务、幂等记录及审计同事务保存，不自动执行。'
          : e.operationId === 'getTask'
            ? 'D4 详情查询成功响应；同团队只读查询当前持久化状态，replayed=false。'
            : [
                  'listContent',
                  'getContent',
                  'compareContent',
                  'saveContent',
                  'submitReview',
                  'listReviews',
                  'getReview',
                  'decideReview',
                  'listDecisions',
                  'approveContent',
                  'getConfig',
                  'updateConfig',
                ].includes(e.operationId)
              ? '人工编辑审核真实持久化响应；无需 Agent，写入比较资源版本并支持幂等重放。'
              : '业务实现后的成功响应；当前校验授权后返回 501 占位；发布另有失效批准拒绝校验。',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['data', 'meta'],
            properties: {
              data: { $ref: `#/components/schemas/${e.response}` },
              meta: {
                type: 'object',
                required: ['requestId', 'replayed'],
                properties: { requestId: { type: 'string' }, replayed: { type: 'boolean' } },
              },
            },
          },
        },
      },
    };
    const responses: Record<string, unknown> = { [e.success]: response };
    if (e.operationId === 'approveContent') responses['200'] = response;
    for (const code of [400, 401, 403, 404, 409, 422, 423, 429, 500, 501, 503])
      responses[code] = {
        description: '见统一错误约定；不创建业务成功结果。',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      };
    paths[path] ??= {};
    paths[path]![e.method.toLowerCase()] = {
      operationId: e.operationId,
      summary: e.summary,
      description: `${e.conditions}\n重复/并发：${e.repetition}\n审计：${e.audit}`,
      security: e.operationId === 'login' || e.operationId === 'logout' ? [] : [{ session: [] }],
      parameters,
      ...(e.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: e.body } } } }
        : {}),
      responses,
      'x-roles': e.roles,
      'x-authorization-implemented': true,
      'x-transitions': e.transitions,
      'x-ac': e.ac,
      'x-implementation': [
        'login',
        'getMe',
        'logout',
        'createTask',
        'getTask',
        'listTasks',
        'startTask',
        'retryTask',
        'stopAttempt',
        'taskHistory',
        'clarifyTask',
        'listContent',
        'getContent',
        'compareContent',
        'saveContent',
        'submitReview',
        'listReviews',
        'getReview',
        'decideReview',
        'listDecisions',
        'approveContent',
        'getConfig',
        'updateConfig',
      ].includes(e.operationId)
        ? 'implemented'
        : 'contract-only',
      'x-error-codes': e.errors,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Multi-Agent Ops D1 接口契约',
      version: '0.1.0',
      description:
        '已实现 Session 登录、业务权限、任务创建与查询、模拟执行和澄清恢复，以及无需 Agent 的不可变文案版本、人工编辑、基础审核、主观裁决、允许自批的版本批准和账号配置。编辑、新执行、配置变更使旧批准失效。实际对外发布与真实 Agent 执行尚未接通；其他未实现业务明确返回 501。',
    },
    paths,
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ops_session' } },
      schemas: responseSchemas,
    },
  };
}
