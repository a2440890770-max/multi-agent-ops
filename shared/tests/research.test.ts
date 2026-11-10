import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  ResearchAcceptedResultSchema,
  ResearchContextSchema,
  ResearchReportSchema,
  ResearchRequestSchema,
  ResearchRunResultSchema,
  ResearchContractError,
  validateResearchContext,
  validateResearchResult,
  type ResearchAcceptedResult,
  type ResearchContext,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/research.json', import.meta.url), 'utf8'),
);
const context = () => ResearchContextSchema.parse(fixture.context);
const result = () => ResearchAcceptedResultSchema.parse(fixture.result);
const code = (expected: string) => (error: unknown) =>
  error instanceof ResearchContractError && error.code === expected;

function addGap(r: ResearchAcceptedResult) {
  r.report.status = 'partial';
  r.report.questions[0]!.status = 'partial';
  r.report.questions[0]!.gapIds = ['gap-1'];
  r.report.gaps.push({
    id: 'gap-1',
    questionIds: ['q-1'],
    sectionIds: [],
    severity: 'core',
    claim: '某项核心能力尚未核实。',
    impact: '影响主要介绍。',
    requestedMaterial: '提供直接的一手资料。',
  });
}
function supplement(): { c: ResearchContext; r: ResearchAcceptedResult } {
  const old = result();
  addGap(old);
  const c = context();
  c.authorization = { id: 'auth-2', mode: 'supplement' };
  c.previousReport = old;
  c.supplementScope = { questionIds: ['q-1'], gapIds: ['gap-1'] };
  const r = result();
  r.id = 'research-2';
  r.version = 2;
  r.parentResultId = old.id;
  r.authorizationId = 'auth-2';
  r.report.changes = [
    { kind: 'gap_resolved', previousRef: 'gap-1', currentRef: null, reason: '已查明。' },
  ];
  return { c, r };
}

test('固定官方资料可逐级追溯到原文；共享契约可导出 JSON Schema', () => {
  assert.deepEqual(validateResearchContext(context()), context());
  assert.deepEqual(validateResearchResult(result(), context()), result());
  for (const schema of [
    ResearchContextSchema,
    ResearchReportSchema,
    ResearchRequestSchema,
    ResearchRunResultSchema,
  ]) {
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })));
  }
});

test('报告不接受模型伪造执行/审批字段，失败结果不携带伪造报告', () => {
  assert.equal(
    ResearchReportSchema.safeParse({ ...result().report, approvalId: 'fake' }).success,
    false,
  );
  assert.equal(
    ResearchReportSchema.safeParse({ ...result().report, status: 'failed' }).success,
    false,
  );
  assert.equal(
    ResearchRunResultSchema.safeParse({
      outcome: 'failed',
      execution: context().execution,
      authorizationId: 'auth-1',
      report: null,
      toolAttempts: [],
      error: { code: 'TIMEOUT', message: '已超时。' },
    }).success,
    true,
  );
  assert.equal(
    ResearchRunResultSchema.safeParse({ outcome: 'failed', result: result() }).success,
    false,
  );
});

test('可选视频失败保留失败记录与警告，充分证据的报告仍为 completed', () => {
  const r = result();
  r.toolAttempts.push({
    ...r.toolAttempts[0]!,
    id: 'video-failed',
    toolUseId: 'video-tool',
    toolName: 'mcp__research_media__fetch_video',
    site: null,
    query: null,
    sourceId: 'source-1',
    status: 'failed',
    errorCode: 'PLATFORM_NOT_ENABLED',
  });
  r.report.warnings.push({
    code: 'OPTIONAL_VIDEO_FAILED',
    message: '视频未取得，结论仅依据官方正文。',
    relatedRefs: ['video-failed'],
  });
  assert.equal(validateResearchResult(r, context()).report.status, 'completed');
  r.report.warnings = [];
  assert.throws(() => validateResearchResult(r, context()), code('TOOL_FAILURE_WARNING_REQUIRED'));
});

test('必需章节不足保留章节和缺口，不能标记 completed 或附造结论', () => {
  const r = result();
  r.report.status = 'partial';
  r.report.sections[0]!.status = 'insufficient_evidence';
  r.report.sections[0]!.claimIds = [];
  r.report.sections[0]!.gapIds = ['gap-1'];
  r.report.gaps = [
    {
      id: 'gap-1',
      questionIds: [],
      sectionIds: ['section-1'],
      severity: 'noncritical',
      claim: '无法判断创新点。',
      impact: '不得宣传创新。',
      requestedMaterial: '提供比较证据。',
    },
  ];
  assert.equal(validateResearchResult(r, context()).report.status, 'partial');
  r.report.status = 'completed';
  assert.throws(() => validateResearchResult(r, context()), code('REPORT_STATUS_INVALID'));
});

test('问题、来源、证据、原文位置及重复 ID 不能伪造', () => {
  const cases: [string, (r: ResearchAcceptedResult) => void][] = [
    [
      'EVIDENCE_SOURCE_INVALID',
      (r) => {
        r.report.evidence[0]!.materialId = 'missing';
      },
    ],
    [
      'EXCERPT_INVALID',
      (r) => {
        r.report.evidence[0]!.excerpt = '编造的原文';
      },
    ],
    [
      'TEXT_LOCATION_INVALID',
      (r) => {
        r.report.evidence[0]!.locator = { kind: 'text', startOffset: 0, endOffset: 999 };
      },
    ],
    [
      'CLAIM_REFERENCE_INVALID',
      (r) => {
        r.report.claims[0]!.evidenceIds = ['missing'];
      },
    ],
    [
      'QUESTION_REFERENCE_INVALID',
      (r) => {
        r.report.questions[0]!.claimIds = ['missing'];
      },
    ],
    [
      'ID_DUPLICATE',
      (r) => {
        r.report.claims[0]!.id = 'source-1';
      },
    ],
  ];
  for (const [expected, mutate] of cases) {
    const r = result();
    mutate(r);
    assert.throws(() => validateResearchResult(r, context()), code(expected));
  }
});

test('核心事实不能仅依赖搜索摘要或间接证据', () => {
  const r = result();
  r.materials[0]!.kind = 'search_snippet';
  assert.throws(() => validateResearchResult(r, context()), code('CORE_PRIMARY_EVIDENCE_REQUIRED'));
  r.materials[0]!.kind = 'webpage_text';
  r.report.evidence[0]!.directness = 'indirect';
  assert.throws(() => validateResearchResult(r, context()), code('CORE_PRIMARY_EVIDENCE_REQUIRED'));
});

test('用户正文自称已确认无效；真实确认必须绑定资料版本并保留未独立核验标记', () => {
  const r = result();
  r.sources[0]!.nature = 'user_provided';
  assert.throws(() => validateResearchResult(r, context()), code('UNCONFIRMED_USER_FACT'));
  r.materials[0]!.firstHandConfirmation = {
    userId: 'user-1',
    confirmedAt: context().runtimeContext.now,
    materialVersion: 1,
  };
  assert.throws(() => validateResearchResult(r, context()), code('USER_MATERIAL_LABEL_REQUIRED'));
  r.report.claims[0]!.limitations = ['用户提供，未经外部独立核验'];
  assert.equal(validateResearchResult(r, context()).report.status, 'completed');
  r.materials[0]!.firstHandConfirmation.materialVersion = 2;
  assert.throws(() => validateResearchResult(r, context()), code('CONFIRMATION_INVALID'));
});

test('观点须注明归属；推断须有依据和限制；推断引用不能形成循环', () => {
  const r = result();
  const c = r.report.claims[0]!;
  c.kind = 'third_party_opinion';
  assert.throws(() => validateResearchResult(r, context()), code('ATTRIBUTION_REQUIRED'));
  c.attribution = '项目作者';
  c.limitations = ['作者观点，未经实测。'];
  assert.doesNotThrow(() => validateResearchResult(r, context()));
  c.kind = 'inference';
  c.premiseClaimIds = [c.id];
  assert.throws(() => validateResearchResult(r, context()), code('PREMISE_CYCLE'));
});

test('全部必需搜索需有真实调用记录，缺失不能宣称 completed', () => {
  const r = result();
  r.toolAttempts.pop();
  assert.throws(() => validateResearchResult(r, context()), code('REQUIRED_SEARCH_MISSING'));
  const c = context();
  c.runtimeContext.requiredSearchSites.pop();
  assert.throws(() => validateResearchContext(c), code('SEARCH_SITES_INVALID'));
});

test('核心问题不能丢失或降级，核心问题的缺口也不能降级', () => {
  const r = result();
  r.report.questions[0]!.severity = 'noncritical';
  assert.throws(() => validateResearchResult(r, context()), code('QUESTION_DOWNGRADED'));
  const missing = result();
  missing.report.questions[0]!.id = 'replacement';
  missing.report.claims[0]!.questionIds = ['replacement'];
  assert.throws(() => validateResearchResult(missing, context()), code('QUESTION_DOWNGRADED'));
  const gap = result();
  addGap(gap);
  gap.report.gaps[0]!.severity = 'noncritical';
  assert.throws(() => validateResearchResult(gap, context()), code('CORE_GAP_DOWNGRADED'));
});

test('补充研究保留完整报告和原证据，缺口解决有版本及变更记录', () => {
  const { c, r } = supplement();
  assert.doesNotThrow(() => validateResearchResult(r, c));
  r.report.changes = [];
  assert.throws(() => validateResearchResult(r, c), code('CHANGE_RECORD_REQUIRED'));
  const lost = supplement();
  lost.r.report.evidence[0]!.excerpt += '新增';
  assert.throws(() => validateResearchResult(lost.r, lost.c));
});

test('撤回的旧结论不留在新版正文，新增/修正均须有变更记录', () => {
  const { c, r } = supplement();
  const oldClaim = r.report.claims[0]!;
  r.report.claims = [{ ...oldClaim, id: 'claim-new', statement: '更新后的有效结论。' }];
  r.report.questions[0]!.claimIds = ['claim-new'];
  r.report.sections[0]!.claimIds = ['claim-new'];
  r.report.changes.push({
    kind: 'revised',
    previousRef: 'fact-1',
    currentRef: 'claim-new',
    reason: '更正表述。',
  });
  assert.doesNotThrow(() => validateResearchResult(r, c));
  r.report.changes.push({
    kind: 'retracted',
    previousRef: 'fact-1',
    currentRef: null,
    reason: '撤回旧说法。',
  });
  r.report.claims.push(oldClaim);
  assert.throws(() => validateResearchResult(r, c), code('SUPERSEDED_BODY_REFERENCE'));
});

test('跨任务、跨尝试、改选项目的旧报告不能成为补充研究输入', () => {
  for (const field of ['taskId', 'attemptId'] as const) {
    const { c } = supplement();
    c.previousReport!.execution[field] = 'other';
    assert.throws(() => validateResearchContext(c), code('HISTORY_SCOPE_INVALID'));
  }
  const { c } = supplement();
  c.selectedProject.selectionId = 'other-selection';
  assert.throws(() => validateResearchContext(c), code('HISTORY_PROJECT_INVALID'));
});

test('补充研究不能越过授权问题或复用旧授权；首次研究不带旧报告', () => {
  const { c } = supplement();
  c.supplementScope!.questionIds = ['not-authorized'];
  assert.throws(() => validateResearchContext(c), code('SUPPLEMENT_GAP_INVALID'));
  const reused = supplement().c;
  reused.authorization.id = 'auth-1';
  assert.throws(() => validateResearchContext(reused), code('SUPPLEMENT_AUTHORIZATION_REQUIRED'));
  const initial = context();
  initial.previousReport = result();
  assert.throws(() => validateResearchContext(initial), code('INITIAL_HISTORY_FORBIDDEN'));
});

test('字幕与抽帧证据只引用已登记产物及实际覆盖时间', () => {
  const r = result();
  r.materials[0]!.kind = 'transcript';
  r.materials[0]!.segments = [
    { id: 'segment-1', text: r.report.evidence[0]!.excerpt, startSeconds: 1, endSeconds: 2 },
  ];
  r.materials[0]!.coverage = { startSeconds: 1, endSeconds: 3 };
  r.report.evidence[0]!.locator = { kind: 'video', startSeconds: 1, endSeconds: 2 };
  assert.doesNotThrow(() => validateResearchResult(r, context()));
  r.report.evidence[0]!.locator = { kind: 'video', startSeconds: 1, endSeconds: 4 };
  assert.throws(() => validateResearchResult(r, context()), code('VIDEO_LOCATION_INVALID'));
  r.materials[0]!.kind = 'frames';
  r.materials[0]!.assetIds = ['frame-1'];
  r.materials[0]!.segments = [];
  r.materials[0]!.framePositions = [{ frameAssetId: 'frame-1', timeSeconds: 2 }];
  r.report.evidence[0]!.locator = { kind: 'frame', frameAssetId: 'fake-frame', timeSeconds: 2 };
  assert.throws(() => validateResearchResult(r, context()), code('FRAME_REFERENCE_INVALID'));
});

test('Skill 必需章节不可遗漏，输入资料的真实确认元数据不得被报告改写', () => {
  const c = context();
  c.runtimeContext.skills[0]!.requiredSections.push({ id: 'limits', title: '限制' });
  assert.throws(() => validateResearchResult(result(), c), code('REQUIRED_SECTION_MISSING'));
  const input = context();
  input.referenceMaterials = { sources: result().sources, materials: result().materials };
  const r = result();
  r.materials[0]!.version = 2;
  assert.throws(() => validateResearchResult(r, input), code('INPUT_MATERIAL_CHANGED'));
});
