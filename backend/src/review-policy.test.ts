import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewResultSchema } from '@multi-agent-ops/shared';
import type { ReviewResult, WorkflowInput } from '@multi-agent-ops/shared';
import { basicIssues, reviewRecord } from './review-policy.js';
const input: WorkflowInput = {
  role: 'review',
  request: '活动从今天开始',
  body: '活动从今天开始',
  round: 0,
  suggestions: [],
  sources: [{ id: 'request', text: '活动从今天开始' }],
};
const review: ReviewResult = {
  outcome: 'pass',
  checks: ['事实检查'],
  suggestions: [],
  scores: [{ name: '质量', value: 100 }],
  blockingIssues: [],
  factualEvidenceSufficient: true,
  hasFactualClaims: true,
  facts: [{ claim: '活动从今天开始', sourceId: 'request', quote: '活动从今天开始' }],
};
test('100 分不能绕过事实缺口、未知来源、虚构引文或模型返回的阻断', () => {
  for (const result of [
    { ...review, factualEvidenceSufficient: false },
    { ...review, facts: [] },
    { ...review, facts: [{ ...review.facts[0]!, sourceId: 'invented' }] },
    { ...review, facts: [{ ...review.facts[0]!, quote: '活动免费' }] },
    { ...review, blockingIssues: [{ kind: 'factual' as const, message: '仍需证据' }] },
  ]) {
    const record = reviewRecord('cycle', 'version', input, result, new Date());
    assert.notEqual(record.outcome, 'pass');
    assert.ok(record.blockingIssues.some((issue) => issue.kind === 'factual'));
  }
  assert.equal(reviewRecord('cycle', 'version', input, review, new Date()).outcome, 'pass');
});
test('结构化 Review 缺少事实判定或越界评分时拒绝采用输出', () => {
  const incomplete: Partial<ReviewResult> = { ...review };
  delete incomplete.factualEvidenceSufficient;
  assert.equal(reviewResultSchema.safeParse(incomplete).success, false);
  assert.equal(
    reviewResultSchema.safeParse({ ...review, scores: [{ name: '质量', value: 101 }] }).success,
    false,
  );
});
test('基础校验按 Unicode 字符计数，控制字符与空白独立阻断', () => {
  assert.equal(basicIssues('😀'.repeat(2000)).length, 0);
  assert.equal(basicIssues('😀'.repeat(2001))[0]?.kind, 'deterministic');
  assert.equal(basicIssues(' \n\t').length, 1);
  assert.equal(basicIssues('正文\u0000')[0]?.kind, 'deterministic');
});
