import type { PublishOperation, TaskDetail } from '@multi-agent-ops/shared';

export function manualRetryReason(
  detail: Pick<
    TaskDetail,
    'task' | 'account' | 'currentContent' | 'currentApproval' | 'currentReview'
  >,
  operation: PublishOperation | null,
  entryReason: string | null,
): string | null {
  if (!operation || operation.status !== 'failed') return '仅已明确未发布的失败交接可以重新交接。';
  if (entryReason) return entryReason;
  const { snapshot } = operation;
  if (
    detail.task.currentContentVersionId !== operation.contentVersionId ||
    detail.currentContent?.contentHash !== operation.contentHash ||
    detail.currentApproval?.id !== snapshot.approval.id ||
    detail.currentReview?.id !== snapshot.approval.reviewCycleId ||
    detail.account?.id !== operation.accountId ||
    detail.account?.platformAccountId !== snapshot.account.platformAccountId
  )
    return '原版本、审核、批准或账号已变化，不能复用此交接；请保存新版本后审核批准。';
  const dispatch = operation.dispatches.find((d) => d.id === operation.currentDispatchId);
  if (!dispatch || dispatch.channel !== 'manual' || dispatch.status !== 'failed')
    return '仅支持已结束且未发布的人工交接。';
  const proof = operation.verifications.filter((r) => r.dispatchId === dispatch.id).at(-1);
  if (
    !proof ||
    proof.method !== 'manual' ||
    proof.conclusion !== 'not_published' ||
    !proof.manualConfirmed ||
    !proof.previousDispatchFenced ||
    proof.mismatchNote ||
    !proof.note.trim() ||
    !proof.evidenceRefs.length
  )
    return '缺少原发送已确认未发布、且不会继续发布的有效证据。';
  return null;
}
