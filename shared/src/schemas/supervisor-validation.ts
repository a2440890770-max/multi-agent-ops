import {
  SupervisorOutputSchema,
  type SupervisorContext,
  type SupervisorOutput,
  type SupervisorReferenceFailure,
} from './supervisor.js';
import { type ResearchAcceptedResult } from './research.js';

export class SupervisorDecisionError extends Error {
  constructor(
    readonly code: string,
    readonly referenceFailure?: SupervisorReferenceFailure,
  ) {
    super(code);
  }
}
/** The only fixed field paths allowed as Supervisor basis/warning references. */
export const SUPERVISOR_FIXED_REFERENCE_PATHS = [
  'task.originalRequest',
  'task.title',
  'accountContext.description',
  'accountContext.defaultAudience',
  'accountContext.defaultTone',
  'accountContext.prohibitions',
] as const;

/** Host-generated catalog, shared by prompts, trusted tool responses and validation. */
export function buildAllowedReferences(
  context: SupervisorContext,
  results: readonly ResearchAcceptedResult[] = [],
): string[] {
  return [
    ...new Set([
      ...SUPERVISOR_FIXED_REFERENCE_PATHS,
      ...Object.values(context.execution),
      ...(context.hotList ? [context.hotList.id, ...context.hotList.items.map((i) => i.id)] : []),
      ...(context.selectedProject ? [context.selectedProject.selectionId] : []),
      ...context.task.referenceInputs.map((r) => r.id),
      ...context.clarifications.map((r) => r.questionId),
      ...context.memoryContext.map((r) => r.id),
      ...context.contextSelection.includedRefs,
      ...results.flatMap((r) => [
        r.id,
        ...r.sources.map((s) => s.id),
        ...r.materials.map((m) => m.id),
        ...r.report.claims.map((c) => c.id),
        ...r.report.gaps.map((g) => g.id),
        ...r.report.evidence.map((e) => e.id),
        ...r.report.questions.map((q) => q.id),
        ...r.report.sections.map((s) => s.id),
        ...r.toolAttempts.map((c) => c.id),
      ]),
    ]),
  ];
}
/** Shared semantic guard at both sides of the private service boundary. */
export function validateSupervisorDecision(
  value: unknown,
  context: SupervisorContext,
  results: ResearchAcceptedResult[],
): SupervisorOutput {
  const parsed = SupervisorOutputSchema.safeParse(value);
  const check = (condition: unknown, code: string): void => {
    if (!condition) throw new SupervisorDecisionError(code);
  };
  if (!parsed.success) throw new SupervisorDecisionError('SUPERVISOR_OUTPUT_INVALID');
  const output = parsed.data;
  const refs = new Set(buildAllowedReferences(context, results));
  const invalidReferences: SupervisorReferenceFailure['invalidReferences'] = [];
  let invalidReferenceCount = 0;
  const inspectRef = (ref: string, path: string) => {
    if (refs.has(ref)) return;
    invalidReferenceCount++;
    if (invalidReferences.length < 20)
      invalidReferences.push({
        path,
        value: ref.slice(0, 256),
        truncated: ref.length > 256,
        reason: 'not_in_allowed_context_reference_set',
      });
  };
  output.basisRefs.forEach((ref, index) => inspectRef(ref, `basisRefs.${index}`));
  output.warnings.forEach((warning, index) =>
    warning.relatedRefs.forEach((ref, refIndex) =>
      inspectRef(ref, `warnings.${index}.relatedRefs.${refIndex}`),
    ),
  );
  if (invalidReferenceCount)
    throw new SupervisorDecisionError('SUPERVISOR_REFERENCE_INVALID', {
      invalidReferences,
      invalidReferenceCount,
      allowedReferenceCount: refs.size,
    });
  for (const d of output.defaultsUsed) {
    const configured =
      d.field === 'audience'
        ? context.accountContext.defaultAudience
        : context.accountContext.defaultTone;
    check(
      d.basis === 'account_configuration' ? d.value === configured : configured === null,
      'SUPERVISOR_DEFAULT_INVALID',
    );
  }
  if (output.decision === 'needs_clarification') return output;
  if (output.decision === 'awaiting_selection') {
    check(
      !context.selectedProject &&
        !!context.hotList?.items.length &&
        output.hotListSnapshotId === context.hotList.id,
      'SUPERVISOR_SELECTION_INVALID',
    );
    return output;
  }
  check(context.selectedProject, 'SUPERVISOR_SELECTION_REQUIRED');
  const current = results.at(-1);
  if (!current || current.id !== output.researchResultId)
    throw new SupervisorDecisionError('SUPERVISOR_RESEARCH_REQUIRED');
  const core = current.report.gaps.filter((g) => g.severity === 'core');
  if (output.decision === 'needs_materials') {
    const gaps = output.blockingGaps.map((g) => g.researchGapId);
    check(
      new Set(gaps).size === gaps.length &&
        gaps.length === core.length &&
        core.every((g) => gaps.includes(g.id)),
      'SUPERVISOR_GAP_INVALID',
    );
    return output;
  }
  check(core.length === 0, 'SUPERVISOR_EVIDENCE_INSUFFICIENT');
  const claims = output.contentBrief.usableClaimIds;
  check(
    new Set(claims).size === claims.length &&
      claims.every((id) => current.report.claims.some((c) => c.id === id)),
    'SUPERVISOR_CLAIM_INVALID',
  );
  const noncritical = current.report.gaps.filter((g) => g.severity === 'noncritical');
  const excluded = output.contentBrief.exclusions.map((e) => e.researchGapId);
  check(
    new Set(excluded).size === excluded.length &&
      excluded.length === noncritical.length &&
      noncritical.every(
        (g) => excluded.includes(g.id) && output.warnings.some((w) => w.relatedRefs.includes(g.id)),
      ),
    'SUPERVISOR_EXCLUSION_INVALID',
  );
  return output;
}
