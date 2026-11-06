import { draftResultSchema, reviewResultSchema } from '@multi-agent-ops/shared';
import type { DraftResult, ReviewResult, WorkflowInput } from '@multi-agent-ops/shared';
import type { SimulationScenario } from './schema.js';

export interface WorkflowProvider {
  generate(input: WorkflowInput): Promise<DraftResult>;
  review(input: WorkflowInput): Promise<ReviewResult>;
}
export function agentProvider(baseUrl: string): WorkflowProvider {
  async function call(input: WorkflowInput): Promise<unknown> {
    const response = await fetch(new URL('/workflow', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(65000),
    });
    if (!response.ok) throw new Error('Agent structured workflow failed');
    return response.json();
  }
  return {
    generate: async (input) => draftResultSchema.parse(await call({ ...input, role: 'content' })),
    review: async (input) => reviewResultSchema.parse(await call({ ...input, role: 'review' })),
  };
}
export function mockProvider(scenario: SimulationScenario): WorkflowProvider {
  return {
    async generate(input) {
      return {
        body: `【模拟产出，仅用于流程验证】\n${input.request}\n${input.round ? `修改第 ${input.round} 轮：已根据建议调整表达。` : '一起关注生活中的新发现，分享你的想法吧！'}\n#今日分享#`,
      };
    },
    async review(input) {
      const failing = scenario === 'review_failure';
      const factual = scenario === 'factual_failure';
      return {
        outcome: failing ? 'changes_required' : 'pass',
        checks: ['任务符合度', '事实依据', '文案质量'],
        suggestions: failing
          ? [`第 ${input.round} 轮：请改善开头与互动表达。`]
          : factual
            ? ['请补充事实依据或删除无依据的断言。']
            : [],
        scores: [{ name: '综合质量', value: factual ? 99 : failing ? 55 : 90 }],
        blockingIssues: failing ? [{ kind: 'subjective', message: '表达质量仍需改善。' }] : [],
        factualEvidenceSufficient: !factual,
        hasFactualClaims: factual,
        facts: [],
      };
    },
  };
}
