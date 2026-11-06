import { z } from 'zod';
import {
  SupervisorContextSchema,
  SupervisorOutputSchema,
  type SupervisorContext,
  type SupervisorOutput,
} from '@multi-agent-ops/shared';
import { SUPERVISOR_PROMPT_VERSION, SUPERVISOR_TOOL_POLICY_VERSION } from './prompt.js';
import { SupervisorError, type SupervisorResearchView } from './types.js';

const text = z.string().min(1).regex(/\S/);
const researchViewSchema = z.strictObject({
  id: text,
  taskId: text,
  attemptId: text,
  sourceIds: z.array(text),
  facts: z.array(z.strictObject({ id: text, sourceIds: z.array(text).min(1) })),
  gaps: z.array(
    z.strictObject({ id: text, severity: z.enum(['core', 'noncritical']), claim: text }),
  ),
  data: z.json(),
});

export function parseSupervisorContext(value: unknown): SupervisorContext {
  const parsed = SupervisorContextSchema.safeParse(value);
  if (!parsed.success)
    throw new SupervisorError('SUPERVISOR_CONTEXT_INVALID', 'Supervisor 输入上下文未通过校验。');
  const context = parsed.data;
  if (
    context.runtimePolicy.promptVersion !== SUPERVISOR_PROMPT_VERSION ||
    context.runtimePolicy.toolPolicyVersion !== SUPERVISOR_TOOL_POLICY_VERSION
  )
    throw new SupervisorError(
      'SUPERVISOR_VERSION_MISMATCH',
      '上下文与实际 Prompt/工具规则版本不一致。',
    );
  if (context.researchContext.authorizationUsed && !context.researchContext.authorizationId)
    throw new SupervisorError('RESEARCH_AUTHORIZATION_INVALID', '已使用的研究授权缺少标识。');
  return context;
}

export function parseResearchView(
  value: unknown,
  context: SupervisorContext,
): SupervisorResearchView {
  const parsed = researchViewSchema.safeParse(value);
  if (!parsed.success)
    throw new SupervisorError(
      'RESEARCH_RESULT_INVALID',
      'Research 接入方未提供有效的已校验结果视图。',
    );
  const view = parsed.data;
  if (view.taskId !== context.execution.taskId || view.attemptId !== context.execution.attemptId)
    throw new SupervisorError(
      'RESEARCH_RESULT_SCOPE_INVALID',
      '研究结果不属于当前任务和执行尝试。',
    );
  const ids = [
    view.id,
    ...view.sourceIds,
    ...view.facts.map((f) => f.id),
    ...view.gaps.map((g) => g.id),
  ];
  const sources = new Set(view.sourceIds);
  if (
    new Set(ids).size !== ids.length ||
    view.facts.some((fact) => fact.sourceIds.some((source) => !sources.has(source)))
  )
    throw new SupervisorError('RESEARCH_REFERENCE_INVALID', '研究结果的标识或事实来源引用无效。');
  return view;
}

export function parseAcceptedResearchViews(
  values: SupervisorResearchView[],
  context: SupervisorContext,
): SupervisorResearchView[] {
  const views = values.map((value) => parseResearchView(value, context));
  const expected = context.researchContext.acceptedResultIds;
  if (
    new Set(expected).size !== expected.length ||
    views.length !== expected.length ||
    views.some((view, index) => view.id !== expected[index])
  )
    throw new SupervisorError(
      'RESEARCH_REFERENCE_INVALID',
      '已采用研究结果必须与输入快照的引用及顺序一致。',
    );
  return views;
}

/** Pure business validation; source truth and authorization storage remain the caller's responsibility. */
export function validateSupervisorOutput(
  value: unknown,
  context: SupervisorContext,
  researchResults: SupervisorResearchView[],
): SupervisorOutput {
  const parsed = SupervisorOutputSchema.safeParse(value);
  if (!parsed.success)
    throw new SupervisorError(
      'SUPERVISOR_OUTPUT_INVALID',
      'Supervisor 输出未通过共享 Schema 校验。',
    );
  const output = parsed.data;
  const knownRefs = new Set([
    ...Object.values(context.execution),
    'task.originalRequest',
    'task.title',
    'accountContext.description',
    'accountContext.defaultAudience',
    'accountContext.defaultTone',
    'accountContext.prohibitions',
    ...context.task.referenceInputs.map((source) => source.id),
    ...context.clarifications.map((question) => question.questionId),
    ...context.memoryContext.map((memory) => memory.id),
    ...context.contextSelection.includedRefs,
    ...researchResults.flatMap((result) => [
      result.id,
      ...result.sourceIds,
      ...result.facts.map((fact) => fact.id),
      ...result.gaps.map((gap) => gap.id),
    ]),
  ]);
  if (
    [...output.basisRefs, ...output.warnings.flatMap((warning) => warning.relatedRefs)].some(
      (ref) => !knownRefs.has(ref),
    )
  )
    throw new SupervisorError('SUPERVISOR_REFERENCE_INVALID', '输出引用了当前上下文不存在的依据。');
  for (const used of output.defaultsUsed) {
    const configured =
      used.field === 'audience'
        ? context.accountContext.defaultAudience
        : context.accountContext.defaultTone;
    if (
      (used.basis === 'account_configuration' && used.value !== configured) ||
      (used.basis === 'reasonable_default' && configured !== null)
    )
      throw new SupervisorError('SUPERVISOR_DEFAULT_INVALID', '默认值与实际账号配置不一致。');
  }
  if (output.decision === 'needs_clarification') return output;

  // A new round supersedes the previous round's gap assessment; do not select an older report.
  const current = researchResults.at(-1);
  if (!current || current.id !== output.researchResultId)
    throw new SupervisorError(
      'SUPERVISOR_RESEARCH_REQUIRED',
      '该决定必须引用最新的已校验研究结果。',
    );
  const coreGaps = current.gaps.filter((gap) => gap.severity === 'core');
  if (output.decision === 'needs_materials') {
    const supplied = output.blockingGaps.map((gap) => gap.researchGapId);
    if (
      new Set(supplied).size !== supplied.length ||
      supplied.length !== coreGaps.length ||
      coreGaps.some((gap) => !supplied.includes(gap.id))
    )
      throw new SupervisorError(
        'SUPERVISOR_GAP_INVALID',
        '待补资料必须列出全部关键缺口，不能编造或降级缺口。',
      );
    return output;
  }
  if (coreGaps.length)
    throw new SupervisorError(
      'SUPERVISOR_EVIDENCE_INSUFFICIENT',
      '关键证据缺口未解决，不能交给创作。',
    );
  const factIds = new Set(current.facts.map((fact) => fact.id));
  if (output.contentBrief.usableFactIds.some((factId) => !factIds.has(factId)))
    throw new SupervisorError('SUPERVISOR_FACT_INVALID', '创作交接引用了未经校验的事实。');
  const gaps = current.gaps.filter((gap) => gap.severity === 'noncritical');
  const excluded = output.contentBrief.exclusions.map((item) => item.researchGapId);
  if (
    new Set(excluded).size !== excluded.length ||
    excluded.length !== gaps.length ||
    gaps.some((gap) => !excluded.includes(gap.id)) ||
    gaps.some((gap) => !output.warnings.some((warning) => warning.relatedRefs.includes(gap.id)))
  )
    throw new SupervisorError(
      'SUPERVISOR_EXCLUSION_INVALID',
      '非关键缺口必须逐项排除并保留关联警告。',
    );
  return output;
}
