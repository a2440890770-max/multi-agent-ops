import { randomUUID } from 'node:crypto';
import type {
  ReviewIssue,
  ReviewRecord,
  ReviewResult,
  WorkflowInput,
} from '@multi-agent-ops/shared';

export const MAX_AUTO_REVISIONS = 3;
export function basicIssues(body: string): ReviewIssue[] {
  const messages: string[] = [];
  if (!body.trim()) messages.push('文案不能为空。');
  if ([...body].length > 2000) messages.push('文案超过本项目单条微博 2000 字上限，请缩短后重审。');
  if (
    [...body].some((char) => {
      const code = char.codePointAt(0)!;
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    messages.push('文案包含不可发送的控制字符。');
  return messages.map((message) => ({
    id: randomUUID(),
    kind: 'deterministic',
    message,
    resolved: false,
  }));
}

export function reviewRecord(
  cycleId: string,
  versionId: string,
  input: WorkflowInput,
  result: ReviewResult,
  now: Date,
): ReviewRecord {
  const issues: ReviewIssue[] = [
    ...basicIssues(input.body),
    ...result.blockingIssues.map((issue) => ({ ...issue, id: randomUUID(), resolved: false })),
  ];
  const sufficient =
    result.factualEvidenceSufficient &&
    !result.blockingIssues.some((issue) => issue.kind === 'factual') &&
    (!result.hasFactualClaims || result.facts.length > 0) &&
    result.facts.every((fact) => {
      const source = input.sources.find((source) => source.id === fact.sourceId);
      return (
        !!source &&
        !!fact.quote.trim() &&
        !!fact.claim.trim() &&
        input.body.includes(fact.claim) &&
        source.text.includes(fact.quote)
      );
    });
  if (!sufficient)
    issues.push({
      id: randomUUID(),
      kind: 'factual',
      message: '事实证据不足或引文无法核对；请补充依据或删除相关断言后重审，评分不能替代证据。',
      resolved: false,
    });
  if (result.outcome !== 'pass' && !issues.length)
    issues.push({
      id: randomUUID(),
      kind: 'subjective',
      message: result.suggestions.join('；') || '审核要求进一步修改。',
      resolved: false,
    });
  return {
    id: randomUUID(),
    cycleId,
    contentVersionId: versionId,
    outcome: issues.length
      ? result.outcome === 'manual_required'
        ? 'manual_required'
        : 'changes_required'
      : 'pass',
    checks: ['基础校验：非空、2000 字上限、控制字符', ...result.checks],
    suggestions: result.suggestions,
    factualEvidenceSufficient: sufficient,
    factChecks: result.facts,
    blockingIssues: issues,
    scores: result.scores.map((score) => ({ ...score, source: 'model' })),
    sourceRefs: [...new Set(result.facts.map((f) => f.sourceId))]
      .filter((id) => input.sources.some((s) => s.id === id))
      .map((id) => ({ id, label: '任务提供的事实原文', url: null })),
    createdAt: now.toISOString(),
  };
}
