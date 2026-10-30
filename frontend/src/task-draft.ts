import type { OperationBodies } from '@multi-agent-ops/shared';

export type TaskDraft = {
  title: string;
  originalRequest: string;
  referenceLabel: string;
  referenceUrl: string;
  pending: { key: string; body: OperationBodies['createTask']; startedAt: number } | null;
};
export const emptyDraft = (): TaskDraft => ({
  title: '',
  originalRequest: '',
  referenceLabel: '',
  referenceUrl: '',
  pending: null,
});
export const draftKey = (teamId: string, memberId: string) =>
  `ops-task-draft-v1:${teamId}:${memberId}`;
export function readDraft(key: string): TaskDraft {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return emptyDraft();
    const value: TaskDraft = JSON.parse(raw);
    if (
      !value ||
      !['title', 'originalRequest', 'referenceLabel', 'referenceUrl'].every(
        (field) => typeof value[field as keyof TaskDraft] === 'string',
      )
    )
      return emptyDraft();
    if (
      value.pending &&
      (typeof value.pending.key !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(value.pending.key) ||
        !Number.isFinite(value.pending.startedAt) ||
        !value.pending.body ||
        typeof value.pending.body.title !== 'string' ||
        typeof value.pending.body.originalRequest !== 'string' ||
        (value.pending.body.referenceInputs !== undefined &&
          (!Array.isArray(value.pending.body.referenceInputs) ||
            value.pending.body.referenceInputs.some(
              (r) => !r || typeof r.label !== 'string' || typeof r.url !== 'string',
            ))))
    )
      return emptyDraft();
    return { ...value, pending: value.pending ?? null };
  } catch {
    return emptyDraft();
  }
}
export function saveDraft(key: string, value: TaskDraft) {
  try {
    if (
      !value.title &&
      !value.originalRequest &&
      !value.referenceUrl &&
      !value.referenceLabel &&
      !value.pending
    )
      sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* A browser without storage can still submit and retry during this page visit. */
  }
}
export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Storage may be disabled by the browser. */
  }
}
