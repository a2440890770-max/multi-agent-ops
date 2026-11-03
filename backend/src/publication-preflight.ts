import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Failure, Session, TaskDetail } from '@multi-agent-ops/shared';
import type { EditorialTransaction } from './editorial-state.js';
import { manualEntryReason } from './manual-publication-entry.js';
import {
  accounts,
  auditEvents,
  configVersions,
  publicationDispatches,
  publicationOperations,
  publicationSendClaims,
  taskApprovals,
  taskDecisions,
  tasks,
} from './schema.js';

type Operation = typeof publicationOperations.$inferSelect;
type Dispatch = typeof publicationDispatches.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
const blocked = (code: string, message: string): Failure => ({
  code,
  message: `未发送：${message}`,
  retryable: false,
});

/** Read inside the same team/task transaction used to admit a send or retry. */
export async function publicationPreflight(
  tx: EditorialTransaction,
  detail: TaskDetail,
  operation?: Operation,
): Promise<Failure | null> {
  const {
    task,
    currentContent: content,
    currentApproval: approval,
    currentAttempt: attempt,
  } = detail;
  if (
    task.lifecycle === 'terminated' ||
    task.terminatedAt ||
    (attempt?.cancelScope === 'terminate_task' && attempt.cancelRequestedAt)
  )
    return blocked('PUBLICATION_CANCELLED', '任务已终止或已请求终止，不能继续发布。');
  if (task.lifecycle !== 'open' || task.publishedOperationId)
    return blocked('PUBLICATION_TASK_CLOSED', '任务已结束，不能继续发布。');
  if (
    !content ||
    content.id !== task.currentContentVersionId ||
    (operation &&
      (content.id !== operation.contentVersionId ||
        content.contentHash !== operation.contentHash ||
        content.body !== operation.snapshot.content.body)) ||
    createHash('sha256').update(content.body, 'utf8').digest('hex') !== content.contentHash
  )
    return blocked(
      'PUBLICATION_VERSION_CHANGED',
      '当前文案版本或正文摘要已变化，请重新核对并审核批准。',
    );
  if (
    !approval ||
    approval.id !== task.currentApprovalId ||
    (operation && approval.id !== operation.approvalId) ||
    approval.status !== 'approved' ||
    approval.invalidatedAt ||
    approval.taskId !== task.id ||
    approval.contentVersionId !== content.id ||
    approval.contentHash !== content.contentHash ||
    approval.accountId !== task.accountId
  )
    return blocked(
      'PUBLICATION_APPROVAL_INVALID',
      '当前版本的批准已失效或不匹配，请重新审核批准。',
    );
  const [account] = detail.account
    ? await tx.select().from(accounts).where(eq(accounts.id, detail.account.id))
    : [];
  if (
    !account ||
    account.id !== task.accountId ||
    (operation &&
      (account.id !== operation.accountId ||
        account.platformAccountId !== operation.snapshot.account.platformAccountId))
  )
    return blocked('PUBLICATION_ACCOUNT_CHANGED', '目标账号已变化，请重新核对并批准。');
  const [config] = account.currentConfigVersion
    ? await tx
        .select()
        .from(configVersions)
        .where(
          and(
            eq(configVersions.accountId, account.id),
            eq(configVersions.version, account.currentConfigVersion),
          ),
        )
    : [];
  const [approvalRow] = await tx
    .select()
    .from(taskApprovals)
    .where(and(eq(taskApprovals.id, approval.id), eq(taskApprovals.taskId, task.id)));
  if (
    !config ||
    !approvalRow ||
    approvalRow.configVersion !== config.version ||
    (operation && operation.configVersion !== config.version)
  )
    return blocked('PUBLICATION_APPROVAL_INVALID', '审核配置已变化，原批准不能继续使用。');
  const [decision] = detail.currentReview
    ? await tx
        .select()
        .from(taskDecisions)
        .where(
          and(
            eq(taskDecisions.taskId, task.id),
            eq(taskDecisions.reviewId, detail.currentReview.id),
          ),
        )
        .orderBy(desc(taskDecisions.createdAt), desc(taskDecisions.id))
        .limit(1)
    : [];
  const reason = manualEntryReason({
    task: {
      ...task,
      ...(operation && task.activePublishOperationId === operation.id
        ? { activePublishOperationId: null }
        : {}),
    },
    account: {
      ...detail.account!,
      manualPublishEnabled: account.manualPublishEnabled,
      registrationVersion: account.registrationVersion,
      platformAccountId: account.platformAccountId,
    },
    content,
    approval,
    review: detail.currentReview,
    decision: decision?.data ?? null,
    configVersion: config.version,
    forbiddenTopics: config.forbiddenTopics,
    working: !!detail.workLock,
  });
  return reason ? blocked('PUBLICATION_APPROVAL_INVALID', reason) : null;
}

/** Caller owns team/task/operation locks. An existing send claim always wins. */
export async function rejectUnsentPublication(
  tx: EditorialTransaction,
  input: {
    task: TaskRow;
    operation: Operation;
    dispatch: Dispatch;
    failure: Failure;
    actor: Session['member'];
    now: Date;
    releaseTask?: boolean;
  },
): Promise<boolean> {
  const { task, operation, dispatch, failure, actor, now } = input;
  if (
    operation.status !== 'publishing' ||
    dispatch.status !== 'publishing' ||
    dispatch.channel !== 'simulation' ||
    task.activePublishOperationId !== operation.id
  )
    return false;
  const [claim] = await tx
    .select()
    .from(publicationSendClaims)
    .where(eq(publicationSendClaims.dispatchId, dispatch.id));
  if (claim) return false;
  await tx
    .update(publicationDispatches)
    .set({ status: 'failed', finishedAt: now, error: failure })
    .where(eq(publicationDispatches.id, dispatch.id));
  await tx
    .update(publicationOperations)
    .set({ status: 'failed', updatedAt: now })
    .where(eq(publicationOperations.id, operation.id));
  if (input.releaseTask !== false)
    await tx
      .update(tasks)
      .set({ activePublishOperationId: null, revision: task.revision + 1, updatedAt: now })
      .where(eq(tasks.id, task.id));
  await tx.insert(auditEvents).values({
    teamId: task.teamId,
    taskId: task.id,
    actorType: 'member',
    actorId: actor.id,
    action: 'publication.preflight_rejected',
    targetType: 'publication',
    targetId: operation.id,
    beforeRevision: task.revision,
    afterRevision: task.revision + 1,
    outcome: 'rejected',
    reason: `${failure.code}: ${failure.message}`,
    requestId: `preflight:${dispatch.id}`,
    createdAt: now,
  });
  return true;
}
