import { createHash } from 'node:crypto';
import type {
  Account,
  Approval,
  ContentVersion,
  ManualDecision,
  ReviewCycle,
  Task,
} from '@multi-agent-ops/shared';
import { basicIssues, reviewEligible } from './manual-review.js';

type Input = {
  task: Pick<
    Task,
    | 'id'
    | 'accountId'
    | 'lifecycle'
    | 'currentContentVersionId'
    | 'currentReviewCycleId'
    | 'currentApprovalId'
    | 'activePublishOperationId'
    | 'publishedOperationId'
  >;
  account: Account | null;
  content: ContentVersion | null;
  approval?: Approval | null;
  review?: ReviewCycle | null;
  decision?: ManualDecision | null;
  configVersion?: number | null;
  forbiddenTopics?: string[] | null;
  working: boolean;
};
export function manualEntryReason(input: Input): string | null {
  const { task, account, content, approval, review } = input;
  if (task.lifecycle !== 'open' || task.publishedOperationId)
    return '任务已结束，不能进入人工发布。';
  if (task.activePublishOperationId) return '已有未完成的发布交接，请先处理原操作。';
  if (input.working) return '请先结束当前执行或审核。';
  if (
    !account ||
    account.id !== task.accountId ||
    !account.registrationVersion ||
    !account.platformAccountId
  )
    return '请联系管理员先登记真实微博账号。';
  if (!account.manualPublishEnabled) return '目标账号的人工操作资格尚未启用。';
  if (!content || content.id !== task.currentContentVersionId || content.sourceKind !== 'manual')
    return '请先人工编辑并保存当前文案。';
  const hash = createHash('sha256').update(content.body, 'utf8').digest('hex');
  if (
    !approval ||
    approval.status !== 'approved' ||
    approval.invalidatedAt ||
    approval.id !== task.currentApprovalId ||
    approval.taskId !== task.id ||
    approval.accountId !== account.id ||
    approval.contentVersionId !== content.id ||
    approval.contentHash !== content.contentHash ||
    approval.contentHash !== hash
  )
    return '当前版本尚无有效批准，请先完成审核与批准。';
  if (
    !review ||
    review.id !== task.currentReviewCycleId ||
    review.id !== approval.reviewCycleId ||
    review.taskId !== task.id ||
    review.currentVersionId !== content.id ||
    review.configVersion !== input.configVersion ||
    !review.records.length ||
    review.records.some(
      (record) => record.cycleId !== review.id || record.contentVersionId !== content.id,
    ) ||
    !reviewEligible(review, input.decision)
  )
    return '当前审核或配置已变化，请重新审核与批准。';
  if (!input.forbiddenTopics || basicIssues(content.body, input.forbiddenTopics).length)
    return '当前文案未通过最新基础规则，请修改后重新审核。';
  return null;
}
