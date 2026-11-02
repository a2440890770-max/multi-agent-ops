import type {
  ApiSuccess,
  OperationBodies,
  PublishOperation,
  ResponseModels,
} from '@multi-agent-ops/shared';
import { request, validDetail } from './task-api.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
export function validPublication(v: unknown, taskId: string): v is PublishOperation {
  if (!object(v) || !object(v.snapshot)) return false;
  const { content, account, approval } = v.snapshot;
  return (
    typeof v.id === 'string' &&
    v.taskId === taskId &&
    typeof v.createdBy === 'string' &&
    typeof v.createdAt === 'string' &&
    [
      'awaiting_manual',
      'publishing',
      'verification_required',
      'published',
      'failed',
      'cancelled',
    ].includes(v.status as string) &&
    object(content) &&
    content.taskId === taskId &&
    content.id === v.contentVersionId &&
    content.contentHash === v.contentHash &&
    typeof content.body === 'string' &&
    Number.isSafeInteger(content.versionNo) &&
    object(account) &&
    account.id === v.accountId &&
    typeof account.displayName === 'string' &&
    typeof account.platformAccountId === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(account.platformAccountId) &&
    object(approval) &&
    approval.taskId === taskId &&
    typeof approval.id === 'string' &&
    approval.contentVersionId === v.contentVersionId &&
    approval.contentHash === v.contentHash &&
    approval.accountId === v.accountId &&
    approval.status === 'approved' &&
    typeof approval.approvedBy === 'string' &&
    typeof approval.approvedAt === 'string' &&
    typeof v.snapshot.frozenAt === 'string' &&
    Number.isSafeInteger(v.snapshot.configVersion) &&
    Array.isArray(v.dispatches) &&
    v.dispatches.some(
      (d: unknown) =>
        object(d) &&
        d.id === v.currentDispatchId &&
        d.operationId === v.id &&
        d.approvalId === approval.id &&
        ['manual', 'official_api'].includes(d.channel as string),
    ) &&
    Array.isArray(v.verifications)
  );
}
export function createManualHandoff(
  taskId: string,
  body: OperationBodies['publishContent'],
  csrf: string,
  key: string,
) {
  return request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/publications`,
    { body, csrf, key, successStatus: 202 },
    (v): v is ResponseModels['Publication'] =>
      object(v) &&
      validPublication(v.operation, taskId) &&
      validDetail(v.task) &&
      v.task.task.id === taskId &&
      v.operation.accountId === body.accountId &&
      v.operation.contentVersionId === body.contentVersionId &&
      v.operation.contentHash === body.contentHash,
  );
}

export function recordPublicationResult(
  taskId: string,
  operationId: string,
  kind: 'backfill' | 'verification',
  body: OperationBodies['backfillPublication'],
  csrf: string,
  key: string,
) {
  return request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/publications/${encodeURIComponent(operationId)}/${kind === 'backfill' ? 'backfills' : 'verifications'}`,
    { body, csrf, key, successStatus: 202 },
    (v): v is ResponseModels['Publication'] =>
      object(v) &&
      validPublication(v.operation, taskId) &&
      v.operation.id === operationId &&
      validDetail(v.task) &&
      v.task.task.id === taskId,
  );
}
export function readPublication(taskId: string, operationId: string, signal?: AbortSignal) {
  return request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/publications/${encodeURIComponent(operationId)}`,
    signal ? { signal } : {},
    (v): v is ResponseModels['Publication'] =>
      object(v) &&
      validPublication(v.operation, taskId) &&
      v.operation.id === operationId &&
      validDetail(v.task) &&
      v.task.task.id === taskId,
  );
}
export async function readPublicationHistory(taskId: string, signal: AbortSignal) {
  const items: PublishOperation[] = [];
  let cursor: string | null = null;
  do {
    const result: ApiSuccess<ResponseModels['Publications']> = await request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/publications?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      { signal },
      (v): v is ResponseModels['Publications'] =>
        object(v) &&
        Array.isArray(v.items) &&
        v.items.every((item) => validPublication(item, taskId)) &&
        (v.nextCursor === null || typeof v.nextCursor === 'string'),
    );
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
  } while (cursor);
  return items;
}

export function retryManualPublication(
  taskId: string,
  operationId: string,
  body: OperationBodies['retryPublication'],
  csrf: string,
  key: string,
) {
  return request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/publications/${encodeURIComponent(operationId)}/retries`,
    { body, csrf, key, successStatus: 202 },
    (v): v is ResponseModels['Publication'] =>
      object(v) &&
      validPublication(v.operation, taskId) &&
      v.operation.id === operationId &&
      v.operation.dispatches.some((d) => d.previousDispatchId === body.previousDispatchId) &&
      validDetail(v.task) &&
      v.task.task.id === taskId,
  );
}
