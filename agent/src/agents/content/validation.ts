import { ContentContextSchema, ContentOutputSchema } from '@multi-agent-ops/shared';
import type { ContentContext, ContentPlan } from '@multi-agent-ops/shared';
import { ContentError } from './types.js';

function requireValid(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ContentError(code, message);
}
function unique(values: string[]) {
  return new Set(values).size === values.length;
}

export function parseContentContext(value: unknown): ContentContext {
  const parsed = ContentContextSchema.safeParse(value);
  requireValid(parsed.success, 'CONTENT_CONTEXT_INVALID', 'Content 输入不符合共享契约。');
  const ctx = parsed.data;
  requireValid(
    ctx.controlMode === 'automatic',
    'CONTENT_HUMAN_CONTROL',
    '人工接管期间不调用 Content。',
  );
  requireValid(
    ctx.project.id === ctx.research.projectId,
    'CONTENT_PROJECT_MISMATCH',
    '研究不属于所选项目。',
  );
  const sourceIds = ctx.research.sources.map((s) => s.id);
  const factIds = ctx.research.facts.map((f) => f.id);
  requireValid(
    unique(sourceIds) &&
      unique(factIds) &&
      unique(ctx.research.gaps.map((g) => g.id)) &&
      unique(ctx.usableFactIds),
    'CONTENT_REFERENCE_INVALID',
    '研究标识必须唯一。',
  );
  requireValid(
    ctx.usableFactIds.every((id) => factIds.includes(id)),
    'CONTENT_REFERENCE_INVALID',
    '可用事实必须来自当前研究。',
  );
  for (const fact of ctx.research.facts) {
    requireValid(
      unique(fact.sourceIds) && fact.sourceIds.every((id) => sourceIds.includes(id)),
      'CONTENT_REFERENCE_INVALID',
      '事实引用了不存在的来源。',
    );
    requireValid(
      fact.kind === 'fact' || fact.requiredQualifier,
      'CONTENT_QUALIFIER_REQUIRED',
      '观点和推断必须提供归属或限定。',
    );
  }
  if (ctx.revision.mode === 'revise') {
    requireValid(
      ctx.revision.reviewedVersionId === ctx.revision.parentVersionId,
      'CONTENT_REVIEW_MISMATCH',
      '修订意见必须属于父版本。',
    );
    requireValid(
      unique(ctx.revision.issues.map((i) => i.id)),
      'CONTENT_REFERENCE_INVALID',
      '审核意见标识必须唯一。',
    );
  }
  return ctx;
}

/** Explicit paths only: no arbitrary object traversal or prototype/property access. */
export function contentField(plan: ContentPlan, path: string): string | null {
  if (path === 'title' || path === 'caption' || path === 'projectUrl') return plan[path];
  const cover = /^cover\.(headline|subtitle|visualBrief)$/.exec(path);
  if (cover) return plan.cover[cover[1] as keyof ContentPlan['cover']];
  const page = /^pages\.([^.]+)\.(heading|body|visualBrief)$/.exec(path);
  if (page)
    return (
      plan.pages.find((p) => p.key === page[1])?.[page[2] as 'heading' | 'body' | 'visualBrief'] ??
      null
    );
  const list = /^(hashtags|productionNotes)\.(0|[1-9]\d*)$/.exec(path);
  if (list) return plan[list[1] as 'hashtags' | 'productionNotes'][Number(list[2])] ?? null;
  return null;
}

export function validateContentOutput(value: unknown, ctx: ContentContext) {
  const parsed = ContentOutputSchema.safeParse(value);
  requireValid(parsed.success, 'CONTENT_OUTPUT_INVALID', '候选结果不符合 Content 输出契约。');
  const output = parsed.data;
  // Newly discovered problems have no existing Research gap ID to cite.
  // They stop creation and return to Supervisor without fabricating an ID.
  if (output.decision === 'blocked') return output;
  const coreGaps = ctx.research.gaps.filter((g) => g.severity === 'core');
  if (output.decision === 'needs_materials') {
    requireValid(
      unique(output.gapIds) &&
        output.gapIds.every((id) => ctx.research.gaps.some((g) => g.id === id)) &&
        coreGaps.every((g) => output.gapIds.includes(g.id)),
      'CONTENT_GAP_INVALID',
      '补资料必须引用真实缺口并覆盖核心缺口。',
    );
    return output;
  }
  requireValid(!coreGaps.length, 'CONTENT_CORE_GAP', '存在核心证据缺口，不能交付草案。');
  const { plan } = output;
  requireValid(
    plan.projectUrl === ctx.project.url,
    'CONTENT_PROJECT_MISMATCH',
    '策划不能替换项目链接。',
  );
  requireValid(
    unique(plan.pages.map((p) => p.key)) && plan.pages.every((p) => /^[a-zA-Z0-9_-]+$/.test(p.key)),
    'CONTENT_PAGE_INVALID',
    '页面 key 必须唯一且仅包含字母、数字、下划线和短横线。',
  );
  requireValid(
    ctx.format.pageCount === null || plan.pages.length === ctx.format.pageCount,
    'CONTENT_FORMAT_INVALID',
    '策划页数不符合当前要求。',
  );
  requireValid(
    ctx.format.titleMaxChars === null || [...plan.title].length <= ctx.format.titleMaxChars,
    'CONTENT_FORMAT_INVALID',
    '标题超过当前配置长度。',
  );
  requireValid(
    ctx.format.pageBodyMaxChars === null ||
      plan.pages.every((p) => [...p.body].length <= ctx.format.pageBodyMaxChars!),
    'CONTENT_FORMAT_INVALID',
    '单页正文超过当前配置长度。',
  );
  for (const ref of output.claimRefs) {
    requireValid(
      contentField(plan, ref.fieldPath)?.includes(ref.claim),
      'CONTENT_CLAIM_INVALID',
      '证据映射必须定位到策划原文。',
    );
    requireValid(
      unique(ref.factIds) && unique(ref.sourceIds),
      'CONTENT_REFERENCE_INVALID',
      '证据映射不得重复标识。',
    );
    const facts = ref.factIds.map((id) => ctx.research.facts.find((f) => f.id === id));
    requireValid(
      facts.every((f) => f && ctx.usableFactIds.includes(f.id)),
      'CONTENT_REFERENCE_INVALID',
      '只能使用 Supervisor 允许的当前研究事实。',
    );
    for (const fact of facts) {
      requireValid(
        fact && fact.kind === ref.kind,
        'CONTENT_CLAIM_KIND_INVALID',
        '事实、观点和推断的类型不能转换。',
      );
      requireValid(
        !fact.requiredQualifier || ref.claim.includes(fact.requiredQualifier),
        'CONTENT_QUALIFIER_REQUIRED',
        '表述丢失必要归属或限定。',
      );
      requireValid(
        fact.sourceIds.some((id) => ref.sourceIds.includes(id)),
        'CONTENT_REFERENCE_INVALID',
        '每项事实须保留至少一条支持来源。',
      );
    }
    requireValid(
      ref.sourceIds.every((id) => facts.some((f) => f?.sourceIds.includes(id))),
      'CONTENT_REFERENCE_INVALID',
      '不能引用与所选事实无关的来源。',
    );
  }
  if (ctx.revision.mode === 'initial') {
    requireValid(
      output.changeResponses.length === 0,
      'CONTENT_CHANGE_INVALID',
      '初稿不能伪造修改回复。',
    );
  } else {
    const issues = ctx.revision.issues;
    requireValid(
      unique(output.changeResponses.map((r) => r.issueId)) &&
        output.changeResponses.length === issues.length &&
        output.changeResponses.every((r) => issues.some((i) => i.id === r.issueId)),
      'CONTENT_CHANGE_INVALID',
      '必须逐项回应本次全部审核意见。',
    );
  }
  requireValid(
    output.changeResponses.every((r) =>
      r.fieldPaths.every((path) => contentField(plan, path) !== null),
    ),
    'CONTENT_CHANGE_INVALID',
    '修订回复必须定位到真实字段。',
  );
  return output;
}
