import { createHash, randomUUID } from 'node:crypto';
import {
  ResearchReportSchema,
  ResearchAcceptedResultSchema,
  validateResearchResult,
  type AgentRunRequest,
  type ResearchContext,
  type ResearchAcceptedResult,
  type ResearchExecutionCallback,
  type ResearchWebSnapshot,
} from '@multi-agent-ops/shared';
import { createResearchIntegration } from './integration.js';
import { RESEARCH_PROMPT_VERSION } from './prompt.js';
import { loadGithubProjectResearchSkill } from './skills.js';
import {
  createResearchWebController,
  type ResearchWebOptions,
} from '../../tools/research-web/controller.js';
import { readResearchWebConfig } from '../../tools/research-web/config.js';
import { SupervisorError } from '../supervisor/types.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const rawText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'content' in value && Array.isArray(value.content))
    return value.content
      .map((part: unknown) =>
        part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : '',
      )
      .join('\n');
  throw new SupervisorError('RESEARCH_OUTPUT_INVALID', '研究报告不是完整文本。');
};
function parseReport(value: unknown) {
  let text = rawText(value).trim();
  if (text.startsWith('```json\n') && text.endsWith('\n```')) text = text.slice(8, -4);
  else if (text.startsWith('```\n') && text.endsWith('\n```')) text = text.slice(4, -4);
  try {
    return ResearchReportSchema.parse(JSON.parse(text));
  } catch {
    throw new SupervisorError('RESEARCH_OUTPUT_INVALID', '研究报告 JSON 或结构未通过校验。');
  }
}

/** Native child execution only; format correction uses SubagentStop in the same SDK tree. */
export function createProductionResearch(options: {
  request: AgentRunRequest;
  env: NodeJS.ProcessEnv;
  callback: (
    value: ResearchExecutionCallback,
    signal: AbortSignal,
  ) => Promise<{ accepted: boolean; replayed?: boolean; execute?: boolean }>;
  checkRun: (signal: AbortSignal) => Promise<void>;
  webOptions?: Pick<ResearchWebOptions, 'readOriginal' | 'checkPublicAddress'>;
}) {
  const { request } = options;
  const binding = request.research;
  if (
    !binding ||
    !request.context.selectedProject ||
    !request.context.researchContext.inputs ||
    request.context.researchContext.authorizationId === null
  )
    throw new SupervisorError('RESEARCH_NOT_CONFIGURED', '研究宿主上下文不完整。');
  const skill = loadGithubProjectResearchSkill();
  const expected = binding.scope.researchMethod;
  if (
    expected.promptVersion !== RESEARCH_PROMPT_VERSION ||
    expected.skills[0]?.contentSha256 !==
      createHash('sha256').update(skill.instructions).digest('hex')
  )
    throw new SupervisorError(
      'RESEARCH_SKILL_CONTEXT_MISMATCH',
      '研究 Skill 或 Prompt 与冻结授权不一致。',
    );
  let context: ResearchContext | undefined,
    sdkSessionId = '',
    dispatchToolUseId = '',
    agentId = '';
  let snapshot: ResearchWebSnapshot | undefined,
    registryRevision = 0,
    committed = false;
  let checkedReport: ReturnType<typeof parseReport> | undefined;
  let claimTime = performance.now();
  const resultId = randomUUID();
  const identity = () => {
    if (!context || !sdkSessionId || !dispatchToolUseId)
      throw new SupervisorError('RESEARCH_IDENTITY_INVALID', '研究分派身份尚未建立。');
    return {
      protocolVersion: 1 as const,
      runId: request.runId,
      lease: request.lease,
      execution: request.context.execution,
      researchExecution: context.execution,
      authorizationId: context.authorization.id,
      dispatchToolUseId,
      sdkSessionId,
    };
  };
  const sendRegistry = async (state: ResearchWebSnapshot, signal: AbortSignal) => {
    if (!agentId || committed) return;
    const response = await options.callback(
      {
        ...identity(),
        operation: 'registry',
        agentId,
        registryRevision: ++registryRevision,
        snapshot: state,
        snapshotHash: hash(state),
      },
      signal,
    );
    if (!response.accepted)
      throw new SupervisorError('RESEARCH_REGISTRY_REJECTED', '网页登记未能保存，研究停止。');
  };
  let activeSignal: AbortSignal | undefined;
  const web = createResearchWebController({
    ...options.webOptions,
    config: { ...readResearchWebConfig(options.env), ...binding.webConfig },
    officialSites: binding.scope.sources.officialSites.map((site) => ({
      ...site,
      approvedBy: 'user_confirmation' as const,
      approvalRef: request.context.researchContext.authorizationId!,
    })),
    onSnapshot: async (value) => {
      snapshot = value;
      if (activeSignal) await sendRegistry(value, activeSignal);
    },
  });
  const candidate = async (
    researchContext: ResearchContext,
    output: unknown,
  ): Promise<ResearchAcceptedResult> => {
    const records = await web.getRecords();
    const result = ResearchAcceptedResultSchema.parse({
      id: resultId,
      version: (researchContext.previousReport?.version ?? 0) + 1,
      parentResultId: researchContext.previousReport?.id ?? null,
      execution: researchContext.execution,
      authorizationId: researchContext.authorization.id,
      selectedProject: researchContext.selectedProject,
      report: parseReport(output),
      ...records,
      metadata: {
        promptVersion: RESEARCH_PROMPT_VERSION,
        toolPolicyVersion: expected.toolPolicyVersion,
        configVersion: expected.configVersion,
        skills: expected.skills.map(({ name, version }) => ({ name, version })),
        traceId: request.runId,
        parentToolUseId: dispatchToolUseId,
        durationMs: Math.max(0, Math.round(performance.now() - claimTime)),
      },
    });
    validateResearchResult(result, researchContext);
    await web.validateResultRecords(result);
    return result;
  };
  return createResearchIntegration({
    tools: ['WebSearch', 'WebFetch'],
    maxTurns: request.limits.maxTurns,
    webTools: web,
    claimAuthorization: async (input) => {
      context = input.researchContext;
      activeSignal = input.signal;
      sdkSessionId = input.sdkSessionId ?? '';
      dispatchToolUseId = input.toolUseId;
      claimTime = performance.now();
      const response = await options.callback(
        { ...identity(), operation: 'claim', context },
        input.signal,
      );
      if (!response.accepted || response.execute !== true || response.replayed)
        throw new SupervisorError(
          'RESEARCH_ALREADY_DISPATCHED',
          '授权无法首次准入；未重新分派研究。',
        );
    },
    startAgent: async (input) => {
      if (input.sdkSessionId !== sdkSessionId || input.toolUseId !== dispatchToolUseId)
        throw new SupervisorError('RESEARCH_IDENTITY_INVALID', '子 Agent 不属于本次会话。');
      const response = await options.callback(
        { ...identity(), operation: 'start', agentId: input.agentId },
        input.signal,
      );
      if (!response.accepted)
        throw new SupervisorError('RESEARCH_IDENTITY_INVALID', '子 Agent 登记被拒绝。');
      agentId = input.agentId;
      if (snapshot) await sendRegistry(snapshot, input.signal);
    },
    authorizeTool: async (input) => {
      if (
        input.agentId !== agentId ||
        committed ||
        !['WebSearch', 'WebFetch'].includes(input.toolName)
      )
        return false;
      await options.checkRun(input.signal);
      return true;
    },
    validateReport: async (input) => {
      const result = await candidate(input.researchContext, input.output);
      checkedReport = result.report;
    },
    acceptResult: async (input) =>
      candidate(
        input.researchContext,
        checkedReport ? JSON.stringify(checkedReport) : input.rawResult,
      ),
    commitResult: async (result, signal) => {
      const finalSnapshot = await web.getSnapshot();
      const response = await options.callback(
        { ...identity(), operation: 'result', agentId, result, snapshot: finalSnapshot },
        signal,
      );
      if (!response.accepted)
        throw new SupervisorError('RESEARCH_RESULT_REJECTED', '报告未能通过后端校验提交。');
      committed = true;
    },
  });
}
