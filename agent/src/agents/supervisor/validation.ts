import {
  SupervisorContextSchema,
  SupervisorOutputSchema,
  ResearchRequestSchema,
  validateResearchContext,
  validateResearchResult,
  type ResearchContext,
  validateSupervisorDecision,
  SupervisorDecisionError,
  type SupervisorContext,
  type SupervisorOutput,
} from '@multi-agent-ops/shared';
import { SUPERVISOR_PROMPT_VERSION, SUPERVISOR_TOOL_POLICY_VERSION } from './prompt.js';
import { SupervisorError, type SupervisorResearchView } from './types.js';
import {
  validateStructuredResult,
  StructuredOutputValidationError,
} from '../../structured-model.js';

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
  if (
    context.hotList &&
    new Set(context.hotList.items.map((i) => i.id)).size !== context.hotList.items.length
  )
    throw new SupervisorError('SUPERVISOR_CONTEXT_INVALID', '热榜候选标识重复。');
  const project = context.selectedProject;
  if (project) {
    const candidate = context.hotList?.items.find((i) => i.id === project.candidateId);
    if (
      !candidate ||
      context.hotList?.id !== project.hotListSnapshotId ||
      candidate.repositoryUrl !== project.repositoryUrl ||
      candidate.title !== project.name
    )
      throw new SupervisorError('SUPERVISOR_SELECTION_INVALID', '选中项目必须与热榜快照一致。');
  } else if (
    context.researchContext.authorizationId ||
    context.researchContext.acceptedResultIds.length ||
    context.researchContext.inputs
  ) {
    throw new SupervisorError(
      'SUPERVISOR_SELECTION_REQUIRED',
      '未选定项目前不能授权或开展项目研究。',
    );
  }
  return context;
}

export function parseResearchView(
  value: unknown,
  context: SupervisorContext,
): SupervisorResearchView {
  // Adapter owns source/reading truth; the same shared graph is checked again at the boundary.
  let view: SupervisorResearchView;
  try {
    view = validateResearchResult(value);
  } catch {
    throw new SupervisorError('RESEARCH_RESULT_INVALID', 'Research 结果未通过共享契约及引用校验。');
  }
  if (
    view.execution.taskId !== context.execution.taskId ||
    view.execution.attemptId !== context.execution.attemptId
  )
    throw new SupervisorError(
      'RESEARCH_RESULT_SCOPE_INVALID',
      '研究结果不属于当前任务和执行尝试。',
    );
  if (JSON.stringify(view.selectedProject) !== JSON.stringify(context.selectedProject))
    throw new SupervisorError('RESEARCH_RESULT_SCOPE_INVALID', '研究结果不属于当前选中项目。');
  return view;
}

/** The SDK prompt is a carrier for validated JSON, not an alternate permission channel. */
export function buildResearchContext(
  prompt: string,
  context: SupervisorContext,
  results: SupervisorResearchView[],
): ResearchContext {
  const inputs = context.researchContext.inputs;
  if (!inputs || !context.selectedProject || !context.researchContext.authorizationId)
    throw new SupervisorError('RESEARCH_CONTEXT_REQUIRED', '缺少后端提供的研究执行上下文。');
  if (inputs.mode === 'initial' && results.length)
    throw new SupervisorError('RESEARCH_CONTEXT_INVALID', '已有研究报告时必须按补充研究范围授权。');
  try {
    const request = ResearchRequestSchema.parse(JSON.parse(prompt));
    return validateResearchContext({
      schemaVersion: '1.0',
      execution: { ...context.execution, stepId: inputs.stepId },
      authorization: { id: context.researchContext.authorizationId, mode: inputs.mode },
      selectedProject: context.selectedProject,
      request,
      contentContext: inputs.contentContext,
      referenceMaterials: inputs.referenceMaterials,
      previousReport: inputs.mode === 'supplement' ? (results.at(-1) ?? null) : null,
      supplementScope: inputs.supplementScope,
      runtimeContext: inputs.runtimeContext,
    });
  } catch {
    throw new SupervisorError(
      'RESEARCH_CONTEXT_INVALID',
      '研究要求或研究上下文未通过共享契约校验。',
    );
  }
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

/** Apply the same decision guard at the Agent and backend boundaries. */
export function validateSupervisorOutput(
  value: unknown,
  context: SupervisorContext,
  researchResults: SupervisorResearchView[],
): SupervisorOutput {
  try {
    // Preserve safe Schema issue paths before the shared semantic guard wraps errors.
    validateStructuredResult(
      { subtype: 'success', is_error: false, structured_output: value },
      SupervisorOutputSchema,
    );
    return validateSupervisorDecision(value, context, researchResults);
  } catch (error) {
    if (error instanceof StructuredOutputValidationError)
      throw new SupervisorError('SUPERVISOR_OUTPUT_INVALID', error.message, error.diagnostic);
    const code =
      error instanceof SupervisorDecisionError ? error.code : 'SUPERVISOR_OUTPUT_INVALID';
    const paths: Record<string, string[]> = {
      SUPERVISOR_REFERENCE_INVALID: ['basisRefs', 'warnings.relatedRefs'],
      SUPERVISOR_DEFAULT_INVALID: ['defaultsUsed'],
      SUPERVISOR_SELECTION_INVALID: ['hotListSnapshotId'],
      SUPERVISOR_SELECTION_REQUIRED: ['decision'],
      SUPERVISOR_RESEARCH_REQUIRED: ['researchResultId'],
      SUPERVISOR_GAP_INVALID: ['blockingGaps'],
      SUPERVISOR_EVIDENCE_INSUFFICIENT: ['decision'],
      SUPERVISOR_CLAIM_INVALID: ['contentBrief.usableClaimIds'],
      SUPERVISOR_EXCLUSION_INVALID: ['contentBrief.exclusions', 'warnings.relatedRefs'],
    };
    const referenceFailure =
      error instanceof SupervisorDecisionError ? error.referenceFailure : undefined;
    const issues = (
      referenceFailure
        ? referenceFailure.invalidReferences.map((ref) => ref.path)
        : (paths[code] ?? ['$'])
    ).map((path) => ({ path, code: 'semantic_mismatch' }));
    throw new SupervisorError(
      code,
      `Supervisor 决定与当前依据、研究报告或缺口不一致；字段：${issues.map((i) => i.path).join(', ')}。`,
      {
        hasStructuredOutput: true,
        outputType: 'object',
        errorType: 'semantic_validation_failed',
        issues,
        ...(referenceFailure ? { referenceFailure } : {}),
      },
    );
  }
}
