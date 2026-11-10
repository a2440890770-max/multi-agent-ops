import { z } from 'zod';
import {
  ResearchGapSchema,
  ResearchMaterialSchema,
  ResearchQuestionSchema,
  ResearchRuntimeContextSchema,
  ResearchSourceSchema,
  SelectedProjectSchema,
} from './research.js';

const id = z.string().min(1).max(128).regex(/\S/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.int().positive().max(Number.MAX_SAFE_INTEGER);
const base = { expectedRevision: revision, authorizeResearch: z.literal(true) };
const uniqueIds = (minimum = 0) =>
  z
    .array(id)
    .min(minimum)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'ID 重复');
export const RESEARCH_COMMAND_BODY_LIMIT = 1_048_576;
export const RESEARCH_MATERIAL_TOTAL_CHARACTERS = 100_000;

/** Canonical URL scope only. This never grants permission to follow a link. */
export function normalizeResearchSiteGrant(grant: { origin: string; pathPrefix: string }) {
  const origin = new URL(grant.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !/^[a-z0-9.-]+\.[a-z]+$/i.test(origin.hostname) ||
    /(^|\.)(localhost|local|internal)$/i.test(origin.hostname) ||
    /[\s\\]/.test(grant.origin) ||
    !/^https:\/\/[^/?#]+\/?$/i.test(grant.origin)
  )
    throw new Error('官网 origin 必须是无凭据、路径和非标准端口的 HTTPS 域名。');
  const path = grant.pathPrefix;
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\s\\?#]/.test(path) ||
    /%(?:2f|5c|2e|25)/i.test(path) ||
    /(^|\/)\.{1,2}(\/|$)/.test(path)
  )
    throw new Error('官网路径范围无效或存在编码歧义。');
  const parsed = new URL(path, origin.origin);
  if (parsed.origin !== origin.origin || parsed.pathname !== path)
    throw new Error('请提交规范的官网路径范围。');
  return { origin: origin.origin, pathPrefix: path };
}
export const ResearchSiteGrantRequestSchema = z
  .strictObject({
    origin: z.string().min(1).max(2048),
    pathPrefix: z.string().min(1).max(2048),
  })
  .superRefine((value, ctx) => {
    try {
      normalizeResearchSiteGrant(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: '官网 origin 或路径范围无效。' });
    }
  });
export const SelectProjectAndAuthorizeResearchSchema = z.strictObject({
  ...base,
  attemptId: z.uuid(),
  hotListSnapshotId: z.uuid(),
  candidateId: id,
});
export const RetryResearchAndAuthorizeSchema = z.strictObject({
  ...base,
  previousAttemptId: z.uuid(),
  reason: z.string().min(1).max(2000).regex(/\S/),
});
export const ResearchSubmittedMaterialSchema = z
  .strictObject({
    clientRef: id,
    label: z.string().min(1).max(200).regex(/\S/),
    text: z.string().min(1).max(20_000).regex(/\S/).nullable(),
    sourceUrl: z
      .url()
      .max(2048)
      .regex(/^https?:\/\//)
      .nullable(),
    confirmFirstHand: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.text === null && value.sourceUrl === null)
      ctx.addIssue({ code: 'custom', message: '至少提供文本或来源链接。' });
    if (value.confirmFirstHand && value.text === null)
      ctx.addIssue({ code: 'custom', message: '仅链接不能确认尚未读取的正文。' });
  });
export const SubmitMaterialsAndAuthorizeResearchSchema = z
  .strictObject({
    ...base,
    attemptId: z.uuid(),
    baseResultId: id,
    questionIds: uniqueIds(1),
    gapIds: uniqueIds(),
    materials: z.array(ResearchSubmittedMaterialSchema).max(20),
    confirmExistingMaterials: z
      .array(
        z.strictObject({
          materialId: id,
          materialVersion: z.int().positive(),
          contentSha256: hash,
        }),
      )
      .max(20),
    officialSiteGrants: z.array(ResearchSiteGrantRequestSchema).max(20),
  })
  .superRefine((value, ctx) => {
    const refs = value.materials.map((m) => m.clientRef);
    const confirmations = value.confirmExistingMaterials.map((m) => m.materialId);
    const grants = value.officialSiteGrants.map((g) => {
      try {
        return JSON.stringify(normalizeResearchSiteGrant(g));
      } catch {
        return '';
      }
    });
    if (
      new Set(refs).size !== refs.length ||
      new Set(confirmations).size !== confirmations.length ||
      new Set(grants).size !== grants.length
    )
      ctx.addIssue({ code: 'custom', message: '资料、确认或官网范围不能重复。' });
    if (
      value.materials.reduce((total, m) => total + (m.text?.length ?? 0), 0) >
      RESEARCH_MATERIAL_TOTAL_CHARACTERS
    )
      ctx.addIssue({ code: 'custom', message: '一次提交的资料文本总计不能超过十万字符。' });
  });

/** Host-supplied policy; the server does not enable Research commands until it is wired. */
export const ResearchAuthorizationPolicySchema = z
  .strictObject({
    promptVersion: id,
    toolPolicyVersion: id,
    configVersion: z.int().positive(),
    skills: z
      .array(ResearchRuntimeContextSchema.shape.skills.element.extend({ contentSha256: hash }))
      .length(1),
    limits: ResearchRuntimeContextSchema.shape.limits.extend({ maxVideoCalls: z.literal(0) }),
  })
  .superRefine((policy, ctx) => {
    const skill = policy.skills[0];
    const sections = [
      'gpr-overview',
      'gpr-capabilities',
      'gpr-use-cases',
      'gpr-differentiation',
      'gpr-prerequisites',
      'gpr-limitations',
    ];
    if (
      skill?.name !== 'github-project-research' ||
      skill.version !== '1.0.0' ||
      skill.requiredSections.length !== sections.length ||
      sections.some((id, index) => skill.requiredSections[index]?.id !== id)
    )
      ctx.addIssue({ code: 'custom', message: '必须冻结正式项目研究 Skill 的版本和六章。' });
  });
const materialRef = z.strictObject({
  materialId: id,
  version: z.int().positive(),
  contentSha256: hash,
});
const sourceRef = z.strictObject({
  id,
  label: z.string(),
  url: z.string().nullable(),
});
export const ResearchAuthorizationScopeSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    taskId: z.uuid(),
    attemptId: z.uuid(),
    generation: z.int().positive(),
    selection: SelectedProjectSchema,
    mode: z.enum(['initial', 'supplement']),
    baseResult: z.strictObject({ id, version: z.int().positive() }).nullable(),
    taskInput: z.strictObject({
      title: z.string(),
      originalRequest: z.string(),
      inputRevision: revision,
      referenceInputs: z.array(sourceRef),
      clarifications: z.array(
        z.strictObject({
          questionId: id,
          question: z.string(),
          answer: z.string().nullable(),
        }),
      ),
      sha256: hash,
    }),
    researchMethod: ResearchAuthorizationPolicySchema,
    supplementScope: z
      .strictObject({
        questions: z.array(ResearchQuestionSchema).min(1),
        gaps: z.array(ResearchGapSchema),
      })
      .nullable(),
    submissionId: z.uuid().nullable(),
    submissionRecordCount: z.int().nonnegative().max(40),
    materialRefs: z.array(materialRef),
    sources: z.strictObject({
      repositoryUrl: z.string(),
      requiredSearchSites: z.tuple([
        z.literal('bilibili'),
        z.literal('xiaohongshu'),
        z.literal('douyin'),
      ]),
      officialSites: z.array(ResearchSiteGrantRequestSchema),
    }),
    tools: z.tuple([z.literal('WebSearch'), z.literal('WebFetch')]),
    budget: z.strictObject({
      taskId: z.uuid(),
      maxCostMicrosCny: z.int().positive(),
      maxCalls: z.int().positive(),
      maxTokens: z.int().positive(),
      webRequestMicrosCny: z.int().nonnegative().optional(),
      pricing: z.strictObject({
        version: id,
        inputMicrosCnyPerMillion: z.int().nonnegative(),
        outputMicrosCnyPerMillion: z.int().nonnegative(),
      }),
    }),
  })
  .superRefine((scope, ctx) => {
    const initial = scope.mode === 'initial';
    if (
      scope.budget.taskId !== scope.taskId ||
      scope.sources.repositoryUrl !== scope.selection.repositoryUrl ||
      (initial
        ? scope.baseResult !== null ||
          scope.supplementScope !== null ||
          scope.submissionId !== null ||
          scope.sources.officialSites.length > 0 ||
          scope.materialRefs.length > 0 ||
          scope.submissionRecordCount !== 0
        : !scope.baseResult || !scope.supplementScope || !scope.submissionId)
    )
      ctx.addIssue({ code: 'custom', message: '授权模式、归属或来源范围不一致。' });
    if (new Set(scope.materialRefs.map((m) => m.materialId)).size !== scope.materialRefs.length)
      ctx.addIssue({ code: 'custom', message: '授权材料引用不能重复。' });
    if (scope.supplementScope) {
      const questions = scope.supplementScope.questions.map((q) => q.id);
      const gaps = scope.supplementScope.gaps.map((g) => g.id);
      if (
        new Set(questions).size !== questions.length ||
        new Set(gaps).size !== gaps.length ||
        scope.supplementScope.gaps.some((g) => g.questionIds.some((id) => !questions.includes(id)))
      )
        ctx.addIssue({ code: 'custom', message: '授权补查问题及缺口范围不一致。' });
    }
  });

export const ResearchSubmissionRecordSchema = z.strictObject({
  source: ResearchSourceSchema,
  material: ResearchMaterialSchema.nullable(),
  lineageRootMaterialId: id.nullable(),
  contentSha256: hash.nullable(),
  previousMaterial: materialRef.nullable(),
});
export type ResearchAuthorizationPolicy = z.infer<typeof ResearchAuthorizationPolicySchema>;
export type ResearchAuthorizationScope = z.infer<typeof ResearchAuthorizationScopeSchema>;
export type ResearchSubmissionRecord = z.infer<typeof ResearchSubmissionRecordSchema>;
