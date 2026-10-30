import { randomUUID } from 'node:crypto';
import type { ManualDecision, ReviewCycle, ReviewIssue } from '@multi-agent-ops/shared';

export const defaultEditorialConfig = {
  profile: '团队文案账号，用于人工创作、审核和批准。',
  tone: '自然、克制、清晰',
  forbiddenTopics: ['全网最低', '100%有效'],
  rules: [
    {
      id: 'plain-text-280',
      description: '纯文案，不超过 280 个字符，不含 HTML 标签。',
      deterministic: true,
    },
  ],
  modelRef: 'manual',
  promptVersion: 'manual-v1',
  toolVersion: 'basic-rules-v1',
  maxAutoRevisions: 3 as const,
};

/** Deliberately limited, reproducible checks. No semantic/factual verdict or model score. */
export function basicIssues(body: string, forbiddenTopics: string[]): ReviewIssue[] {
  const problems: string[] = [];
  if (!body.trim()) problems.push('文案不能为空。');
  if ([...body].length > 280) problems.push('文案超过 280 个字符，请缩短后重新审核。');
  if (/<\/?[A-Za-z][^>]*>/.test(body)) problems.push('仅支持纯文案，请移除 HTML 标签。');
  for (const word of forbiddenTopics)
    if (
      word.trim() &&
      body.normalize('NFKC').toLowerCase().includes(word.trim().normalize('NFKC').toLowerCase())
    )
      problems.push(`命中禁止事项：${word}`);
  return problems.map((message) => ({
    id: randomUUID(),
    kind: 'deterministic',
    message,
    resolved: false,
  }));
}

export function reviewEligible(
  review: ReviewCycle | null | undefined,
  decision?: ManualDecision | null,
) {
  if (!review || review.status !== 'completed') return false;
  const issues = review.records.flatMap((r) => r.blockingIssues);
  if (issues.some((i) => i.kind !== 'subjective')) return false;
  if (!issues.length) return true;
  return (
    !!decision &&
    decision.unresolvedIssues.length === 0 &&
    issues.every((i) => decision.acceptedIssues.includes(i.id)) &&
    review.records.some((r) => r.id === decision.reviewRecordId)
  );
}
