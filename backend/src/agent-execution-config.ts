import { z } from 'zod';
import {
  SupervisorLimitsSchema,
  ResearchAuthorizationPolicySchema,
  ResearchWebConfigSchema,
} from '@multi-agent-ops/shared';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readExecutionLimits } from './execution-config.js';
import { readExecutionPricing } from './execution-pricing.js';

export const AgentConfigurationSchema = z.strictObject({
  version: z.literal(1),
  supervisor: SupervisorLimitsSchema,
  maxSessionTokens: z.int().positive(),
  pricing: z.strictObject({
    version: z.string().min(1),
    inputMicrosCnyPerMillion: z.int().nonnegative(),
    outputMicrosCnyPerMillion: z.int().nonnegative(),
  }),
  research: z
    .strictObject({
      policy: ResearchAuthorizationPolicySchema,
      webConfig: ResearchWebConfigSchema.omit({ root: true }),
      webRequestMicrosCny: z.int().nonnegative(),
      acceptedSdkRedirectLimitation: z.literal(true),
    })
    .optional(),
});
export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;

export function readAgentConfiguration(
  env: Record<string, string | undefined>,
): AgentConfiguration {
  const pricing = readExecutionPricing(env);
  if (!pricing || !env.AGENT_SESSION_MAX_BUDGET_USD?.trim())
    throw new Error(
      '真实执行需要版本化人民币计价及 AGENT_SESSION_MAX_BUDGET_USD；不内置单价或汇率。',
    );
  if (env.TASK_RESEARCH_ENABLED && !['true', 'false'].includes(env.TASK_RESEARCH_ENABLED))
    throw new Error('TASK_RESEARCH_ENABLED 必须为 true/false。');
  const enabled = env.TASK_RESEARCH_ENABLED === 'true';
  let research: AgentConfiguration['research'];
  if (enabled) {
    if (!env.TASK_WEB_REQUEST_MICROS_CNY?.trim() || !/^\d+$/.test(env.TASK_WEB_REQUEST_MICROS_CNY))
      throw new Error('Research 需要显式版本化网页请求计价。');
    if (Number(env.AGENT_SESSION_MAX_BUDGET_USD) > 0.1)
      throw new Error('本批 SDK 单会话预算不得超过 0.10 美元。');
    const document = readFileSync(
      new URL('../../agent/skills/github-project-research/SKILL.md', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const start = document.indexOf('\n---\n', 4);
    const instructions = document.slice(start + 5).trim();
    const version = document
      .slice(0, start)
      .match(/ {2}version: ['"]?([^'"\n]+)/)?.[1]
      ?.trim();
    const requiredSections = instructions
      .split('\n')
      .filter((line) => line.startsWith('| `gpr-'))
      .map((line) => {
        const columns = line.split('|');
        return { id: columns[1]!.trim().replaceAll('`', ''), title: columns[2]!.trim() };
      });
    if (
      start < 4 ||
      !document.startsWith('---\n') ||
      !document.includes('name: github-project-research')
    )
      throw new Error('正式研究 Skill 无法加载。');
    const number = (key: string, fallback: number) =>
      env[key]?.trim() ? Number(env[key]) : fallback;
    const webConfig = ResearchWebConfigSchema.omit({ root: true }).parse({
      maxSearchCalls: number('RESEARCH_WEB_MAX_SEARCH_CALLS', 12),
      maxFetchCalls: number('RESEARCH_WEB_MAX_FETCH_CALLS', 10),
      maxSearchResults: number('RESEARCH_WEB_MAX_SEARCH_RESULTS', 10),
      timeoutMs: number('RESEARCH_WEB_TIMEOUT_MS', 60000),
      maxResponseBytes: number('RESEARCH_WEB_MAX_RESPONSE_BYTES', 10485760),
      maxTextCharacters: number('RESEARCH_WEB_MAX_TEXT_CHARACTERS', 50000),
      maxRedirects: number('RESEARCH_WEB_MAX_REDIRECTS', 5),
    });
    research = {
      policy: ResearchAuthorizationPolicySchema.parse({
        promptVersion: 'research-d9-v2',
        toolPolicyVersion: 'research-web-d9-v1',
        configVersion: 1,
        skills: [
          {
            name: 'github-project-research',
            version,
            requiredSections,
            contentSha256: createHash('sha256').update(instructions).digest('hex'),
          },
        ],
        limits: {
          timeoutMs: 900000,
          maxSearchCalls: webConfig.maxSearchCalls,
          maxFetchCalls: webConfig.maxFetchCalls,
          maxVideoCalls: 0,
          maxOutputAttempts: 3,
          maxBudgetUsd: Number(env.AGENT_SESSION_MAX_BUDGET_USD),
        },
      }),
      webConfig,
      webRequestMicrosCny: Number(env.TASK_WEB_REQUEST_MICROS_CNY),
      acceptedSdkRedirectLimitation: true,
    };
  }
  return AgentConfigurationSchema.parse({
    version: 1,
    pricing,
    supervisor: {
      timeoutMs: 900_000,
      maxTurns: Number(env.AGENT_MAX_TURNS || 32),
      maxBudgetUsd: Number(env.AGENT_SESSION_MAX_BUDGET_USD),
      maxOutputTokens: Number(env.AGENT_MAX_OUTPUT_TOKENS || 4096),
      maxOutputAttempts: 3,
    },
    maxSessionTokens: Number(env.AGENT_SESSION_MAX_TOKENS || 100_000),
    ...(research ? { research } : {}),
  });
}

export function readAgentExecutionLimits(env: Record<string, string | undefined>) {
  return {
    ...readExecutionLimits({
      ...env,
      TASK_CALL_TIMEOUT_MS: '900000',
      TASK_STEP_TIMEOUT_MS: '900000',
      TASK_ATTEMPT_TIMEOUT_MS: '1200000',
      TASK_TECHNICAL_MAX_RETRIES: '0',
    }),
  };
}
