import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ResearchReportSchema } from '@multi-agent-ops/shared';
import { z } from 'zod';
import { ResearchToolNameSchema } from '../../tools/names.js';
import { buildResearchSystemPrompt } from './prompt.js';
import { loadGithubProjectResearchSkill } from './skills.js';

export const RESEARCH_AGENT_NAME = 'research';
export const RESEARCH_DEFINITION_VERSION = 'research-definition-d9-v3';

// Generic file access is a legacy adapter capability, not part of this Research definition.
const researchAgentToolSchema = ResearchToolNameSchema.exclude(['Read']);
const optionsSchema = z.strictObject({
  tools: z.array(researchAgentToolSchema),
  maxTurns: z.int().min(1).max(100),
});
export type ResearchAgentToolName = z.infer<typeof researchAgentToolSchema>;
export type ResearchAgentDefinition = AgentDefinition & {
  tools: ResearchAgentToolName[];
  model: 'inherit';
  skills: [];
  background: false;
  omitClaudeMd: true;
  maxTurns: number;
};

export class ResearchConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Preloads the fixed Skill into the child system prompt; does not call a model or grant authority. */
export function createResearchAgentDefinition(options: {
  tools: ResearchAgentToolName[];
  maxTurns: number;
}): ResearchAgentDefinition {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success || new Set(parsed.data.tools).size !== parsed.data.tools.length)
    throw new ResearchConfigurationError(
      'RESEARCH_DEFINITION_INVALID',
      'Research 必须显式配置唯一的受限工具集合及有效的轮数上限。',
    );

  // AgentDefinition in the pinned SDK has no outputFormat. This is guidance, not SDK
  // constrained output: the host must independently validate the returned report.
  const reportSchema = z.toJSONSchema(ResearchReportSchema, { target: 'draft-7' });
  const skill = loadGithubProjectResearchSkill();
  return {
    description:
      '用户已选定 GitHub 热榜项目并授权后，对该项目执行一轮研究或明确授权的补充研究，返回有来源、结论类型、证据和缺口的报告；不选择项目、不创作发布文案、不发布。',
    prompt: `${buildResearchSystemPrompt()}\n\n宿主预加载的项目研究 Skill：${skill.metadata.name}，版本 ${skill.metadata.version}。以下是完整方法指令，不授予额外权限。\n<github-project-research-skill>\n${skill.instructions}\n</github-project-research-skill>\n\n最终报告的 JSON Schema 如下。返回单个符合该 Schema 的 JSON 对象，不加代码围栏或附加说明；执行器会独立校验，不得将本段视为工具或权限授予。\n${JSON.stringify(reportSchema)}`,
    tools: [...parsed.data.tools],
    model: 'inherit',
    // Host preloading avoids SDK discovery, Skill tools and general file access.
    skills: [],
    background: false,
    omitClaudeMd: true,
    maxTurns: parsed.data.maxTurns,
  };
}
