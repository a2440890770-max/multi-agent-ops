import {
  ResearchAcceptedResultSchema,
  ResearchContextSchema,
  type ResearchAcceptedResult,
  type ResearchContext,
} from './research.js';

export class ResearchContractError extends Error {
  constructor(readonly code: string) {
    super(`Research 契约校验失败：${code}`);
  }
}
const check: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new ResearchContractError(code);
};
const unique = (ids: string[]) => new Set(ids).size === ids.length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameProject = (
  a: ResearchAcceptedResult['selectedProject'],
  b: ResearchAcceptedResult['selectedProject'],
) => same(a, b);

/** Structural parsing is separate from reference, scope and coverage validation. */
export function validateResearchContext(value: unknown): ResearchContext {
  const parsed = ResearchContextSchema.safeParse(value);
  check(parsed.success, 'CONTEXT_INVALID');
  const c = parsed.data;
  check(unique(c.request.questions.map((q) => q.id)), 'QUESTION_DUPLICATE');
  check(c.execution.stepId.length > 0, 'STEP_INVALID');
  const sites = c.runtimeContext.requiredSearchSites;
  check(
    sites.length === 3 &&
      unique(sites) &&
      ['bilibili', 'xiaohongshu', 'douyin'].every((s) =>
        sites.includes(s as (typeof sites)[number]),
      ),
    'SEARCH_SITES_INVALID',
  );
  check(unique(c.runtimeContext.skills.map((s) => s.name)), 'SKILL_DUPLICATE');
  const skill = c.runtimeContext.skills.find((s) => s.name === 'github-project-research');
  check(
    skill && skill.requiredSections.length > 0 && unique(skill.requiredSections.map((s) => s.id)),
    'RESEARCH_SKILL_REQUIRED',
  );
  const { sources, materials } = c.referenceMaterials;
  check(unique([...sources.map((s) => s.id), ...materials.map((m) => m.id)]), 'MATERIAL_DUPLICATE');
  const available = new Set([
    ...sources.map((s) => s.id),
    ...materials.map((m) => m.id),
    ...(c.previousReport?.sources.map((s) => s.id) ?? []),
    ...(c.previousReport?.materials.map((m) => m.id) ?? []),
  ]);
  check(
    c.request.referenceIds.every((id) => available.has(id)),
    'REFERENCE_INVALID',
  );
  for (const m of materials) {
    check(
      sources.some((s) => s.id === m.sourceId),
      'MATERIAL_SOURCE_INVALID',
    );
    check(
      !m.firstHandConfirmation || m.firstHandConfirmation.materialVersion === m.version,
      'CONFIRMATION_VERSION_INVALID',
    );
    check(
      !m.firstHandConfirmation ||
        sources.find((s) => s.id === m.sourceId)?.nature === 'user_provided',
      'CONFIRMATION_INVALID',
    );
    check(
      !m.coverage || m.coverage.endSeconds >= m.coverage.startSeconds,
      'MATERIAL_COVERAGE_INVALID',
    );
  }
  if (c.authorization.mode === 'initial') {
    check(c.previousReport === null && c.supplementScope === null, 'INITIAL_HISTORY_FORBIDDEN');
  } else {
    check(c.previousReport && c.supplementScope, 'SUPPLEMENT_HISTORY_REQUIRED');
    const old = validateResearchResult(c.previousReport);
    check(
      old.execution.taskId === c.execution.taskId &&
        old.execution.attemptId === c.execution.attemptId,
      'HISTORY_SCOPE_INVALID',
    );
    check(sameProject(old.selectedProject, c.selectedProject), 'HISTORY_PROJECT_INVALID');
    check(old.authorizationId !== c.authorization.id, 'SUPPLEMENT_AUTHORIZATION_REQUIRED');
    const scope = c.supplementScope;
    check(unique(scope.questionIds) && unique(scope.gapIds), 'SUPPLEMENT_SCOPE_INVALID');
    check(
      scope.gapIds.every((id) =>
        old.report.gaps.some(
          (g) =>
            g.id === id &&
            (g.questionIds.length === 0 ||
              g.questionIds.some((q) => scope.questionIds.includes(q))),
        ),
      ),
      'SUPPLEMENT_GAP_INVALID',
    );
    check(
      c.request.questions.every((q) => scope.questionIds.includes(q.id)) &&
        scope.questionIds.every((id) => c.request.questions.some((q) => q.id === id)),
      'SUPPLEMENT_OUT_OF_SCOPE',
    );
    for (const q of c.request.questions) {
      const previous = old.report.questions.find((p) => p.id === q.id);
      check(
        !previous ||
          (previous.question === q.question &&
            !(previous.severity === 'core' && q.severity !== 'core')),
        'QUESTION_DOWNGRADED',
      );
    }
  }
  return c;
}

/**
 * The host supplies sources/materials/toolAttempts from its real registry, never from model prose.
 * These checks establish traceability, not the semantic truth of a model's interpretation.
 */
export function validateResearchResult(
  value: unknown,
  context?: ResearchContext,
): ResearchAcceptedResult {
  const parsed = ResearchAcceptedResultSchema.safeParse(value);
  check(parsed.success, 'RESULT_INVALID');
  const r = parsed.data;
  check(
    r.parentResultId !== r.id &&
      (r.version === 1 ? r.parentResultId === null : r.parentResultId !== null),
    'RESULT_VERSION_INVALID',
  );
  const report = r.report;
  const allIds = [
    r.id,
    ...r.sources.map((s) => s.id),
    ...r.materials.map((m) => m.id),
    ...report.questions.map((q) => q.id),
    ...report.claims.map((c) => c.id),
    ...report.evidence.map((e) => e.id),
    ...report.gaps.map((g) => g.id),
    ...report.sections.map((s) => s.id),
    ...report.conflicts.map((c) => c.id),
    ...r.toolAttempts.map((a) => a.id),
  ];
  check(unique(allIds), 'ID_DUPLICATE');
  const known = new Set(allIds);
  const sources = new Map(r.sources.map((s) => [s.id, s]));
  const materials = new Map(r.materials.map((m) => [m.id, m]));
  const evidence = new Map(report.evidence.map((e) => [e.id, e]));
  const claims = new Map(report.claims.map((c) => [c.id, c]));
  const questions = new Map(report.questions.map((q) => [q.id, q]));
  const gaps = new Map(report.gaps.map((g) => [g.id, g]));
  const sections = new Map(report.sections.map((s) => [s.id, s]));
  for (const m of r.materials) {
    check(sources.has(m.sourceId), 'MATERIAL_SOURCE_INVALID');
    check(
      !m.coverage || m.coverage.endSeconds >= m.coverage.startSeconds,
      'MATERIAL_COVERAGE_INVALID',
    );
    check(
      !m.firstHandConfirmation ||
        (sources.get(m.sourceId)?.nature === 'user_provided' &&
          m.firstHandConfirmation.materialVersion === m.version),
      'CONFIRMATION_INVALID',
    );
    check(
      m.kind !== 'pasted_text' || sources.get(m.sourceId)?.nature === 'user_provided',
      'PASTED_SOURCE_INVALID',
    );
    check(
      unique(m.assetIds) &&
        unique(m.framePositions.map((f) => f.frameAssetId)) &&
        unique(m.segments.map((s) => s.id)),
      'MATERIAL_LOCATION_DUPLICATE',
    );
    if (m.kind === 'frames') {
      check(
        m.coverage &&
          m.framePositions.length === m.assetIds.length &&
          m.framePositions.every(
            (f) =>
              m.assetIds.includes(f.frameAssetId) &&
              f.timeSeconds >= m.coverage!.startSeconds &&
              f.timeSeconds <= m.coverage!.endSeconds,
          ),
        'FRAME_POSITIONS_INVALID',
      );
    } else check(m.framePositions.length === 0, 'FRAME_POSITIONS_INVALID');
    if (m.kind === 'transcript' || m.kind === 'subtitles') {
      check(
        m.coverage &&
          m.segments.every(
            (s) =>
              s.startSeconds >= m.coverage!.startSeconds &&
              s.endSeconds >= s.startSeconds &&
              s.endSeconds <= m.coverage!.endSeconds,
          ),
        'SEGMENT_LOCATION_INVALID',
      );
    } else check(m.segments.length === 0, 'SEGMENT_LOCATION_INVALID');
  }
  for (const e of report.evidence) {
    const material = materials.get(e.materialId);
    check(
      material && material.sourceId === e.sourceId && sources.has(e.sourceId),
      'EVIDENCE_SOURCE_INVALID',
    );
    const locator = e.locator;
    check(material.kind !== 'sdk_processed', 'PROCESSED_RESULT_NOT_ORIGINAL');
    if (locator.kind === 'text') {
      check(
        ['webpage_text', 'pasted_text', 'search_snippet'].includes(material.kind),
        'TEXT_MATERIAL_INVALID',
      );
      check(
        material.content !== null &&
          locator.startOffset < locator.endOffset &&
          locator.endOffset <= material.content.length,
        'TEXT_LOCATION_INVALID',
      );
      check(
        material.content.slice(locator.startOffset, locator.endOffset) === e.excerpt,
        'EXCERPT_INVALID',
      );
    } else {
      check(material.coverage, 'VIDEO_COVERAGE_REQUIRED');
      const start = locator.kind === 'video' ? locator.startSeconds : locator.timeSeconds;
      const end = locator.kind === 'video' ? locator.endSeconds : locator.timeSeconds;
      check(
        start >= material.coverage.startSeconds &&
          end >= start &&
          end <= material.coverage.endSeconds,
        'VIDEO_LOCATION_INVALID',
      );
      if (locator.kind === 'frame')
        check(
          material.kind === 'frames' &&
            material.framePositions.some(
              (f) =>
                f.frameAssetId === locator.frameAssetId && f.timeSeconds === locator.timeSeconds,
            ),
          'FRAME_REFERENCE_INVALID',
        );
      else check(['subtitles', 'transcript'].includes(material.kind), 'VIDEO_MATERIAL_INVALID');
      if (locator.kind === 'video') {
        const selected = material.segments.filter(
          (s) => s.startSeconds >= start && s.endSeconds <= end,
        );
        check(
          selected.length > 0 &&
            selected.some((s) => s.startSeconds === start) &&
            selected.some((s) => s.endSeconds === end),
          'SEGMENT_LOCATION_INVALID',
        );
        check(
          selected
            .map((s) => s.text)
            .join('\n')
            .includes(e.excerpt),
          'EXCERPT_INVALID',
        );
      }
    }
  }
  for (const c of report.claims) {
    check(
      unique(c.evidenceIds) &&
        unique(c.refutingEvidenceIds) &&
        unique(c.premiseClaimIds) &&
        unique(c.questionIds),
      'CLAIM_REFERENCE_DUPLICATE',
    );
    check(
      [...c.evidenceIds, ...c.refutingEvidenceIds].every((id) => evidence.has(id)) &&
        c.premiseClaimIds.every((id) => claims.has(id)) &&
        c.questionIds.every((id) => questions.has(id)),
      'CLAIM_REFERENCE_INVALID',
    );
    check(
      c.evidenceIds.every((id) => !c.refutingEvidenceIds.includes(id)),
      'EVIDENCE_RELATION_INVALID',
    );
    check(
      c.evidenceIds.length > 0 || (c.kind === 'inference' && c.premiseClaimIds.length > 0),
      'CLAIM_EVIDENCE_REQUIRED',
    );
    if (c.kind === 'third_party_opinion')
      check(c.attribution !== null && c.limitations.length > 0, 'ATTRIBUTION_REQUIRED');
    if (c.kind === 'inference') check(c.limitations.length > 0, 'INFERENCE_LIMITATION_REQUIRED');
    if (c.kind === 'fact') {
      check(
        c.evidenceIds.every((id) => {
          const e = evidence.get(id)!;
          return (
            sources.get(e.sourceId)?.nature !== 'user_provided' ||
            materials.get(e.materialId)?.firstHandConfirmation
          );
        }),
        'UNCONFIRMED_USER_FACT',
      );
      if (c.questionIds.some((id) => questions.get(id)?.severity === 'core')) {
        check(
          c.evidenceIds.some((id) => {
            const e = evidence.get(id)!;
            const material = materials.get(e.materialId)!;
            return (
              e.directness === 'direct' &&
              material.kind !== 'search_snippet' &&
              ((sources.get(e.sourceId)?.nature === 'primary' &&
                sources.get(e.sourceId)?.url !== null) ||
                material.firstHandConfirmation)
            );
          }),
          'CORE_PRIMARY_EVIDENCE_REQUIRED',
        );
      }
    }
    if (
      c.evidenceIds.some(
        (id) => sources.get(evidence.get(id)!.sourceId)?.nature === 'user_provided',
      )
    ) {
      check(c.limitations.includes('用户提供，未经外部独立核验'), 'USER_MATERIAL_LABEL_REQUIRED');
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    check(!active.has(id), 'PREMISE_CYCLE');
    if (visited.has(id)) return;
    active.add(id);
    for (const premise of claims.get(id)!.premiseClaimIds) visit(premise);
    active.delete(id);
    visited.add(id);
  };
  for (const id of claims.keys()) visit(id);
  for (const q of report.questions) {
    check(unique(q.claimIds) && unique(q.gapIds), 'QUESTION_REFERENCE_DUPLICATE');
    check(
      q.claimIds.every((id) => claims.get(id)?.questionIds.includes(q.id)) &&
        q.gapIds.every((id) => gaps.get(id)?.questionIds.includes(q.id)),
      'QUESTION_REFERENCE_INVALID',
    );
    check(
      q.status === 'answered'
        ? q.claimIds.length > 0 && q.gapIds.length === 0
        : q.gapIds.length > 0,
      'QUESTION_COVERAGE_INVALID',
    );
  }
  for (const s of report.sections) {
    check(
      unique(s.claimIds) &&
        unique(s.gapIds) &&
        s.claimIds.every((id) => claims.has(id)) &&
        s.gapIds.every((id) => gaps.get(id)?.sectionIds.includes(s.id)),
      'SECTION_REFERENCE_INVALID',
    );
    check(
      s.status === 'supported'
        ? s.claimIds.length > 0 && s.gapIds.length === 0
        : s.claimIds.length === 0 && s.gapIds.length > 0,
      'SECTION_COVERAGE_INVALID',
    );
  }
  for (const g of report.gaps) {
    check(
      g.questionIds.length + g.sectionIds.length > 0 &&
        unique(g.questionIds) &&
        unique(g.sectionIds),
      'GAP_REFERENCE_REQUIRED',
    );
    check(
      g.questionIds.every((id) => questions.get(id)?.gapIds.includes(g.id)) &&
        g.sectionIds.every((id) => sections.get(id)?.gapIds.includes(g.id)),
      'GAP_REFERENCE_INVALID',
    );
    check(
      !g.questionIds.some((id) => questions.get(id)?.severity === 'core') || g.severity === 'core',
      'CORE_GAP_DOWNGRADED',
    );
  }
  for (const c of report.conflicts) {
    check(
      c.evidenceIds.every((id) => evidence.has(id)),
      'CONFLICT_REFERENCE_INVALID',
    );
    check(
      c.resolution !== null || (c.gapId !== null && gaps.has(c.gapId)),
      'CONFLICT_GAP_REQUIRED',
    );
    check(c.gapId === null || gaps.has(c.gapId), 'CONFLICT_GAP_INVALID');
  }
  for (const angle of report.suggestedAngles)
    check(
      angle.claimIds.every((id) => claims.has(id)),
      'ANGLE_REFERENCE_INVALID',
    );
  for (const warning of report.warnings)
    check(
      warning.relatedRefs.every((id) => known.has(id)),
      'WARNING_REFERENCE_INVALID',
    );
  for (const a of r.toolAttempts) {
    check(a.sourceId === null || sources.has(a.sourceId), 'TOOL_SOURCE_INVALID');
    check(Date.parse(a.finishedAt) >= Date.parse(a.startedAt), 'TOOL_TIME_INVALID');
    check(
      a.status !== 'failed' ||
        (a.errorCode !== null && report.warnings.some((w) => w.relatedRefs.includes(a.id))),
      'TOOL_FAILURE_WARNING_REQUIRED',
    );
  }
  const incomplete =
    report.gaps.length > 0 ||
    report.questions.some((q) => q.status !== 'answered') ||
    report.sections.some((s) => s.status !== 'supported');
  check(report.status === (incomplete ? 'partial' : 'completed'), 'REPORT_STATUS_INVALID');
  if (context) {
    const c = validateResearchContext(context);
    check(
      r.execution.taskId === c.execution.taskId &&
        r.execution.attemptId === c.execution.attemptId &&
        same(r.execution, c.execution),
      'RESULT_SCOPE_INVALID',
    );
    check(
      r.authorizationId === c.authorization.id && sameProject(r.selectedProject, c.selectedProject),
      'RESULT_AUTHORIZATION_INVALID',
    );
    check(
      r.metadata.toolPolicyVersion === c.runtimeContext.toolPolicyVersion &&
        r.metadata.configVersion === c.runtimeContext.configVersion &&
        same(
          r.metadata.skills,
          c.runtimeContext.skills.map(({ name, version }) => ({ name, version })),
        ),
      'RESULT_POLICY_INVALID',
    );
    for (const original of [
      ...(c.previousReport?.report.questions ?? []),
      ...c.request.questions,
    ]) {
      const q = questions.get(original.id);
      check(
        q &&
          q.question === original.question &&
          !(original.severity === 'core' && q.severity !== 'core'),
        'QUESTION_DOWNGRADED',
      );
      if (c.request.questions.some((request) => request.id === original.id))
        check(
          q.origin === 'supervisor' ||
            c.previousReport?.report.questions.some(
              (old) => old.id === q.id && old.origin === q.origin,
            ),
          'QUESTION_ORIGIN_INVALID',
        );
    }
    for (const requirement of c.runtimeContext.skills.find(
      (s) => s.name === 'github-project-research',
    )!.requiredSections) {
      check(
        report.sections.filter((s) => s.requirementRef === requirement.id).length === 1,
        'REQUIRED_SECTION_MISSING',
      );
    }
    for (const site of c.runtimeContext.requiredSearchSites) {
      const attempted = r.toolAttempts.some(
        (a) => a.site === site && a.toolName === 'WebSearch' && a.query !== null,
      );
      check(report.status !== 'completed' || attempted, 'REQUIRED_SEARCH_MISSING');
      check(attempted || report.gaps.length > 0, 'REQUIRED_SEARCH_GAP_REQUIRED');
    }
    for (const original of c.referenceMaterials.sources)
      check(same(sources.get(original.id), original), 'INPUT_SOURCE_CHANGED');
    for (const original of c.referenceMaterials.materials)
      check(same(materials.get(original.id), original), 'INPUT_MATERIAL_CHANGED');
    const old = c.previousReport;
    check(
      r.parentResultId === (old?.id ?? null) && r.version === (old ? old.version + 1 : 1),
      'RESULT_VERSION_INVALID',
    );
    if (!old) check(report.changes.length === 0, 'INITIAL_CHANGES_INVALID');
    else {
      for (const source of old.sources)
        check(same(sources.get(source.id), source), 'HISTORY_SOURCE_LOST');
      for (const material of old.materials)
        check(same(materials.get(material.id), material), 'HISTORY_MATERIAL_LOST');
      for (const e of old.report.evidence)
        check(same(evidence.get(e.id), e), 'HISTORY_EVIDENCE_LOST');
      const oldClaims = new Set(old.report.claims.map((c) => c.id));
      const oldGaps = new Set(old.report.gaps.map((g) => g.id));
      const oldRefs = new Set([...oldClaims, ...oldGaps]);
      for (const change of report.changes) {
        check(
          change.previousRef === null || oldRefs.has(change.previousRef),
          'CHANGE_PREVIOUS_REFERENCE_INVALID',
        );
        check(
          change.currentRef === null ||
            claims.has(change.currentRef) ||
            gaps.has(change.currentRef),
          'CHANGE_CURRENT_REFERENCE_INVALID',
        );
        check(
          change.kind === 'added' || change.kind === 'gap_opened'
            ? change.previousRef === null && change.currentRef !== null
            : change.previousRef !== null,
          'CHANGE_KIND_INVALID',
        );
        if (['added', 'revised'].includes(change.kind))
          check(change.currentRef !== null && claims.has(change.currentRef), 'CHANGE_KIND_INVALID');
        if (['gap_opened', 'gap_changed'].includes(change.kind))
          check(change.currentRef !== null && gaps.has(change.currentRef), 'CHANGE_KIND_INVALID');
        if (['revised', 'retracted'].includes(change.kind))
          check(
            change.previousRef !== null && oldClaims.has(change.previousRef),
            'CHANGE_KIND_INVALID',
          );
        if (['gap_changed', 'gap_resolved'].includes(change.kind))
          check(
            change.previousRef !== null && oldGaps.has(change.previousRef),
            'CHANGE_KIND_INVALID',
          );
        if (['added', 'gap_opened'].includes(change.kind))
          check(!oldRefs.has(change.currentRef!), 'CHANGE_KIND_INVALID');
      }
      for (const previous of [...old.report.claims, ...old.report.gaps]) {
        const current = claims.get(previous.id) ?? gaps.get(previous.id);
        check(
          same(current, previous) || report.changes.some((c) => c.previousRef === previous.id),
          'CHANGE_RECORD_REQUIRED',
        );
        if (!same(current, previous))
          check(
            previous.questionIds.some((id) => c.supplementScope!.questionIds.includes(id)) ||
              c.supplementScope!.gapIds.includes(previous.id),
            'SUPPLEMENT_CHANGE_OUT_OF_SCOPE',
          );
      }
      for (const current of [...report.claims, ...report.gaps])
        check(
          oldRefs.has(current.id) || report.changes.some((c) => c.currentRef === current.id),
          'CHANGE_RECORD_REQUIRED',
        );
      for (const change of report.changes) {
        if (change.kind === 'retracted' || change.kind === 'gap_resolved')
          check(
            change.currentRef === null &&
              !claims.has(change.previousRef!) &&
              !gaps.has(change.previousRef!),
            'RETRACTED_BODY_REFERENCE',
          );
        if (change.kind === 'revised' || change.kind === 'gap_changed') {
          check(change.currentRef !== null, 'CHANGE_CURRENT_REFERENCE_INVALID');
          check(
            change.currentRef === change.previousRef ||
              (!claims.has(change.previousRef!) && !gaps.has(change.previousRef!)),
            'SUPERSEDED_BODY_REFERENCE',
          );
        }
      }
    }
  }
  return r;
}
