import { validateResearchResult } from '@multi-agent-ops/shared';
import type { ResearchIntegration } from '../supervisor/types.js';
import { RESEARCH_MEDIA_TOOL_NAMES } from '../../tools/names.js';
import {
  createResearchAgentDefinition,
  RESEARCH_DEFINITION_VERSION,
  ResearchConfigurationError,
  type ResearchAgentToolName,
} from './definition.js';
import { RESEARCH_PROMPT_VERSION } from './prompt.js';
import { validateResearchSkillRuntimeContext } from './skills.js';

export interface ResearchIntegrationOptions {
  tools: ResearchAgentToolName[];
  maxTurns: number;
  mediaTools?: ResearchIntegration['mediaTools'];
  webTools?: ResearchIntegration['webTools'];
  claimAuthorization: ResearchIntegration['claimAuthorization'];
  authorizeTool: ResearchIntegration['authorizeTool'];
  acceptResult: ResearchIntegration['acceptResult'];
  startAgent?: ResearchIntegration['startAgent'];
  validateReport?: ResearchIntegration['validateReport'];
  /** Called only after every factory-level check; production persists here. */
  commitResult?: (
    result: import('@multi-agent-ops/shared').ResearchAcceptedResult,
    signal: AbortSignal,
  ) => Promise<void>;
}

/** Supplies the real definition; storage, live permissions and source truth stay host-owned. */
export function createResearchIntegration(
  options: ResearchIntegrationOptions,
): ResearchIntegration {
  const definition = createResearchAgentDefinition({
    tools: options.tools,
    maxTurns: options.maxTurns,
  });
  if (
    typeof options.claimAuthorization !== 'function' ||
    typeof options.authorizeTool !== 'function' ||
    typeof options.acceptResult !== 'function'
  )
    throw new ResearchConfigurationError(
      'RESEARCH_ADAPTER_REQUIRED',
      'Research 接入必须提供真实授权、逐次工具权限及结果登记适配器。',
    );
  const requested = definition.tools.filter((tool) => tool.startsWith('mcp__'));
  const registered = options.mediaTools?.toolNames ?? [];
  if (
    requested.length !== registered.length ||
    new Set(registered).size !== registered.length ||
    registered.some(
      (tool) => !RESEARCH_MEDIA_TOOL_NAMES.includes(tool) || !requested.includes(tool),
    ) ||
    Boolean(requested.length) !== Boolean(options.mediaTools) ||
    (options.mediaTools && typeof options.mediaTools.createServer !== 'function')
  )
    throw new ResearchConfigurationError(
      'RESEARCH_MEDIA_CONFIGURATION_INVALID',
      'Research 媒体工具必须与实际 SDK 注册逐项一致。',
    );

  return {
    version: RESEARCH_DEFINITION_VERSION,
    definition,
    validateRuntimeContext: validateResearchSkillRuntimeContext,
    ...(options.mediaTools ? { mediaTools: options.mediaTools } : {}),
    ...(options.webTools ? { webTools: options.webTools } : {}),
    claimAuthorization: async (request) => {
      validateResearchSkillRuntimeContext(request.researchContext.runtimeContext);
      await options.webTools?.bind(request.researchContext);
      await options.claimAuthorization(request);
    },
    authorizeTool: (request) => options.authorizeTool(request),
    ...(options.startAgent ? { startAgent: options.startAgent } : {}),
    ...(options.validateReport ? { validateReport: options.validateReport } : {}),
    acceptResult: async (request) => {
      validateResearchSkillRuntimeContext(request.researchContext.runtimeContext);
      // The adapter obtains sources/materials/attempts from real records and persists the
      // accepted envelope. Validation here never treats model text as a source registry.
      const result = validateResearchResult(
        await options.acceptResult(request),
        request.researchContext,
      );
      await options.webTools?.validateResultRecords(result);
      if (result.metadata.promptVersion !== RESEARCH_PROMPT_VERSION)
        throw new ResearchConfigurationError(
          'RESEARCH_PROMPT_VERSION_MISMATCH',
          'Research 结果记录的 Prompt 版本与实际定义不一致。',
        );
      await options.commitResult?.(result, request.signal);
      return result;
    },
  };
}
