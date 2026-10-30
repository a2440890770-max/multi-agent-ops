import type {
  ApiError,
  ApiSuccess,
  OperationBodies,
  OperationQueries,
  Page,
  TaskDetail,
  TaskSummary,
  ResponseModels,
  ExecutionAttempt,
} from '@multi-agent-ops/shared';

export class TaskRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';
const nullableText = (value: unknown) => value === null || typeof value === 'string';
function validFailure(value: unknown) {
  return (
    value === null ||
    (object(value) &&
      typeof value.code === 'string' &&
      typeof value.message === 'string' &&
      typeof value.retryable === 'boolean')
  );
}
function validAttempt(value: unknown): value is ExecutionAttempt {
  return (
    object(value) &&
    ['id', 'taskId', 'requestedBy', 'createdAt'].every((key) => typeof value[key] === 'string') &&
    Number.isSafeInteger(value.attemptNo) &&
    Number(value.attemptNo) >= 1 &&
    ['mock', 'agent'].includes(value.executorMode as string) &&
    (value.simulationScenario === null ||
      ['success', 'failure', 'clarification'].includes(value.simulationScenario as string)) &&
    [
      'queued',
      'running',
      'awaiting_clarification',
      'manual_required',
      'ready',
      'failed',
      'cancelled',
    ].includes(value.status as string) &&
    ['currentStep', 'startedAt', 'finishedAt', 'cancelReason'].every((key) =>
      nullableText(value[key]),
    ) &&
    validFailure(value.error)
  );
}
function validSummary(value: unknown): value is TaskSummary {
  if (!object(value) || !object(value.task)) return false;
  const task = value.task;
  return (
    ['id', 'title', 'originalRequest', 'teamId', 'createdBy', 'createdAt', 'updatedAt'].every(
      (key) => typeof task[key] === 'string',
    ) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(task.id as string) &&
    nullableText(task.accountId) &&
    Number.isSafeInteger(task.revision) &&
    Number(task.revision) >= 1 &&
    ['open', 'terminated', 'published'].includes(task.lifecycle as string) &&
    Array.isArray(task.referenceInputs) &&
    task.referenceInputs.every(
      (r: unknown) =>
        object(r) && typeof r.id === 'string' && typeof r.label === 'string' && nullableText(r.url),
    ) &&
    Array.isArray(task.clarifications) &&
    task.clarifications.every(
      (q: unknown) =>
        object(q) &&
        typeof q.questionId === 'string' &&
        typeof q.question === 'string' &&
        nullableText(q.answer),
    ) &&
    nullableText(value.currentStep) &&
    nullableText(value.execution) &&
    typeof value.approval === 'string' &&
    typeof value.publication === 'string'
  );
}
function validDetail(value: unknown): value is TaskDetail {
  return (
    validSummary(value) &&
    object(value) &&
    nullableText(value.errorMessage) &&
    object(value.actions) &&
    ['start', 'retry', 'stop'].every(
      (key) =>
        object(value.actions) &&
        object(value.actions[key]) &&
        typeof value.actions[key].allowed === 'boolean' &&
        nullableText(value.actions[key].reason),
    ) &&
    (value.currentAttempt === null ||
      (validAttempt(value.currentAttempt) &&
        value.currentAttempt.taskId === value.task.id &&
        value.currentAttempt.id === value.task.currentAttemptId)) &&
    (value.currentContent === null ||
      (object(value.currentContent) && typeof value.currentContent.body === 'string')) &&
    (value.account === null ||
      (object(value.account) &&
        typeof value.account.id === 'string' &&
        typeof value.account.displayName === 'string' &&
        typeof value.account.authorizationStatus === 'string'))
  );
}

async function request<T>(
  path: string,
  options: {
    body?: unknown;
    successStatus?: number;
    key?: string;
    csrf?: string;
    signal?: AbortSignal;
  },
  validate: (value: unknown) => value is T,
): Promise<ApiSuccess<T>> {
  const writing = options.body !== undefined;
  const creating = writing && path === '/api/v1/tasks';
  let response: Response;
  try {
    response = await fetch(path, {
      method: writing ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
      headers: {
        ...(writing ? { 'content-type': 'application/json' } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
      },
      ...(writing ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new TaskRequestError(
      0,
      'NETWORK_ERROR',
      creating
        ? '暂时无法确认创建结果，请重试确认本次提交。'
        : writing
          ? '操作结果尚未确认，请重试确认上次操作。'
          : '任务加载失败，请检查连接后重试。',
      writing,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TaskRequestError(
      response.status,
      'INVALID_RESPONSE',
      creating
        ? '暂时无法确认创建结果，请重试确认本次提交。'
        : writing
          ? '操作结果尚未确认，请重试确认上次操作。'
          : '任务服务响应异常，请稍后重试。',
      writing,
    );
  }
  if (!response.ok) {
    const error = body as Partial<ApiError> | null;
    const code = error?.error?.code ?? 'REQUEST_FAILED';
    const message =
      response.status === 401
        ? '登录已失效，请重新登录后继续。'
        : response.status === 403
          ? '当前身份无权执行此操作，请重新检查登录状态。'
          : response.status === 404
            ? '任务不存在或你无权查看。'
            : response.status >= 500
              ? creating
                ? '任务保存暂不可用，请重试确认本次提交。'
                : writing
                  ? '执行服务暂不可用，请重试确认上次操作。'
                  : '任务服务暂不可用，请稍后重试。'
              : typeof error?.error?.message === 'string'
                ? error.error.message
                : '请求未完成，请稍后重试。';
    throw new TaskRequestError(
      response.status,
      code,
      message,
      writing && (response.status >= 500 || code === 'IDEMPOTENCY_KEY_REUSED'),
    );
  }
  if (
    response.status !== (options.successStatus ?? (creating ? 201 : 200)) ||
    !object(body) ||
    !validate(body.data) ||
    !object(body.meta) ||
    typeof body.meta.replayed !== 'boolean' ||
    typeof body.meta.requestId !== 'string'
  )
    throw new TaskRequestError(
      response.status,
      'INVALID_RESPONSE',
      creating
        ? '暂时无法确认创建结果，请重试确认本次提交。'
        : writing
          ? '操作结果尚未确认，请重试确认上次操作。'
          : '任务服务响应异常，请稍后重试。',
      writing,
    );
  return body as unknown as ApiSuccess<T>;
}

export function createTask(body: OperationBodies['createTask'], csrf: string, key: string) {
  return request('/api/v1/tasks', { body, csrf, key }, validDetail);
}
export async function getTaskDetail(taskId: string, signal: AbortSignal) {
  const result = await request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    { signal },
    validDetail,
  );
  if (result.data.task.id.toLowerCase() !== taskId.toLowerCase())
    throw new TaskRequestError(503, 'INVALID_RESPONSE', '任务服务返回了不匹配的任务，请重新加载。');
  return result.data;
}

export async function getTasks(query: OperationQueries['listTasks'], signal: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const result = await request(
    `/api/v1/tasks?${params}`,
    { signal },
    (value): value is Page<TaskSummary> =>
      object(value) &&
      Array.isArray(value.items) &&
      value.items.every(validSummary) &&
      nullableText(value.nextCursor),
  );
  return result.data;
}

export type ExecutionCommand =
  | { kind: 'clarify'; body: OperationBodies['clarifyTask'] }
  | { kind: 'start'; body: OperationBodies['startTask'] }
  | { kind: 'retry'; body: OperationBodies['retryTask'] }
  | { kind: 'stop'; attemptId: string; body: OperationBodies['stopAttempt'] };
export function runTaskCommand(
  taskId: string,
  command: ExecutionCommand,
  csrf: string,
  key: string,
) {
  const base = `/api/v1/tasks/${encodeURIComponent(taskId)}`;
  const path =
    command.kind === 'clarify'
      ? `${base}/clarifications`
      : command.kind === 'start'
        ? `${base}/attempts`
        : command.kind === 'retry'
          ? `${base}/attempt-retries`
          : `${base}/attempts/${encodeURIComponent(command.attemptId)}/stop`;
  return request(path, { body: command.body, csrf, key, successStatus: 202 }, validDetail);
}
export async function getTaskHistory(taskId: string, signal: AbortSignal) {
  const result = await request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/history`,
    { signal },
    (value): value is ResponseModels['History'] =>
      object(value) &&
      Array.isArray(value.attempts) &&
      value.attempts.every((a: unknown) => validAttempt(a) && a.taskId === taskId) &&
      Array.isArray(value.clarificationAnswers) &&
      value.clarificationAnswers.every(
        (a: unknown) =>
          object(a) &&
          a.taskId === taskId &&
          ['id', 'attemptId', 'questionId', 'question', 'answer', 'answeredBy', 'answeredAt'].every(
            (key) => typeof a[key] === 'string',
          ),
      ) &&
      Array.isArray(value.steps) &&
      value.steps.every(
        (s: unknown) =>
          object(s) &&
          typeof s.id === 'string' &&
          typeof s.attemptId === 'string' &&
          typeof s.role === 'string' &&
          typeof s.status === 'string' &&
          validFailure(s.error) &&
          (s.durationMs === null || typeof s.durationMs === 'number'),
      ) &&
      object(value.audit) &&
      Array.isArray(value.audit.items) &&
      nullableText(value.audit.nextCursor),
  );
  return result.data;
}
