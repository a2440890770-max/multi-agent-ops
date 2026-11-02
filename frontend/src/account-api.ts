import type {
  Account,
  AccountRegistration,
  OperationBodies,
  ResponseModels,
} from '@multi-agent-ops/shared';
import { request } from './task-api.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
function validAccount(v: unknown): v is Account {
  return (
    object(v) &&
    typeof v.id === 'string' &&
    typeof v.displayName === 'string' &&
    v.platform === 'weibo' &&
    ['unconfigured', 'valid', 'expired'].includes(v.authorizationStatus as string) &&
    typeof v.officialPublishAvailable === 'boolean' &&
    (v.platformAccountId === null ||
      (typeof v.platformAccountId === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(v.platformAccountId))) &&
    typeof v.manualPublishEnabled === 'boolean' &&
    Number.isSafeInteger(v.registrationVersion) &&
    Number(v.registrationVersion) >= 0
  );
}
function validRegistration(v: unknown): v is AccountRegistration {
  return (
    object(v) &&
    (v.account === null || validAccount(v.account)) &&
    (v.registeredBy === null || typeof v.registeredBy === 'string') &&
    (v.registeredAt === null || typeof v.registeredAt === 'string')
  );
}
export function readAccountRegistration(signal?: AbortSignal) {
  return request('/api/v1/account-registration', signal ? { signal } : {}, validRegistration);
}
export function saveAccountRegistration(
  body: OperationBodies['registerAccount'],
  csrf: string,
  key: string,
) {
  return request(
    '/api/v1/account-registration',
    { body, method: 'PUT', csrf, key, successStatus: 200 },
    validRegistration,
  );
}
export function readManualPublicationEntry(taskId: string, signal: AbortSignal) {
  return request(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/manual-publication-entry`,
    { signal },
    (v): v is ResponseModels['ManualPublicationEntry'] =>
      object(v) &&
      validAccount(v.account) &&
      object(v.content) &&
      v.content.taskId === taskId &&
      typeof v.content.id === 'string' &&
      typeof v.content.body === 'string' &&
      typeof v.content.contentHash === 'string' &&
      object(v.approval) &&
      v.approval.taskId === taskId &&
      v.approval.contentVersionId === v.content.id &&
      v.approval.contentHash === v.content.contentHash &&
      v.approval.accountId === v.account.id &&
      v.approval.status === 'approved' &&
      Number.isSafeInteger(v.revision),
  );
}
export function weiboUid(value: string): string | null {
  const text = value.trim();
  if (/^[1-9][0-9]{0,19}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      !['weibo.com', 'www.weibo.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return /^\/u\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
