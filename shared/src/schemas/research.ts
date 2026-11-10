import { z } from 'zod';

const text = z.string().min(1).regex(/\S/);
const id = text;
const time = z.iso.datetime({ offset: true });
const webUrl = z.url().regex(/^https?:\/\//);
const repositoryUrl = z.url().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/);
export const ExecutionRefSchema = z.strictObject({
  taskId: id,
  attemptId: id,
  stepId: id,
  inputSnapshotId: id,
});
export const EvidenceSeveritySchema = z.enum(['core', 'noncritical']);
export const ResearchModeSchema = z.enum(['initial', 'supplement']);
export const ResearchSiteSchema = z.enum(['bilibili', 'xiaohongshu', 'douyin']);
export const SelectedProjectSchema = z.strictObject({
  selectionId: id,
  candidateId: id,
  hotListSnapshotId: id,
  name: text,
  repositoryUrl,
});
export const GithubHotListSchema = z.strictObject({
  id,
  provider: z.literal('xxapi'),
  fetchedAt: time,
  rankingDescription: text.nullable(),
  items: z.array(z.strictObject({ id, title: text, description: z.string(), repositoryUrl })),
});
export const ResearchQuestionSchema = z.strictObject({
  id,
  question: text,
  severity: EvidenceSeveritySchema,
  reason: text,
});
/** Supervisor supplies this JSON inside the native Agent prompt; the host validates it. */
export const ResearchRequestSchema = z.strictObject({
  topic: text,
  objective: text,
  questions: z.array(ResearchQuestionSchema).min(1),
  scope: z.strictObject({ inclusions: z.array(text), exclusions: z.array(text) }),
  referenceIds: z.array(id),
});
export const ResearchSourceSchema = z.strictObject({
  id,
  label: text,
  url: webUrl.nullable(),
  nature: z.enum(['primary', 'third_party', 'user_provided', 'unknown']),
  author: text.nullable(),
  publishedAt: time.nullable(),
});
/** Created by the host from actual reads. A statement inside material content is not confirmation. */
export const ResearchMaterialSchema = z.strictObject({
  id,
  sourceId: id,
  version: z.int().positive(),
  kind: z.enum([
    'webpage_text',
    'pasted_text',
    'subtitles',
    'transcript',
    'frames',
    'search_snippet',
    'sdk_processed',
  ]),
  content: z.string().nullable(),
  assetIds: z.array(id),
  segments: z.array(z.strictObject({ id, text, startSeconds: z.number(), endSeconds: z.number() })),
  framePositions: z.array(
    z.strictObject({ frameAssetId: id, timeSeconds: z.number().nonnegative() }),
  ),
  capturedAt: time,
  truncated: z.boolean(),
  coverage: z.strictObject({ startSeconds: z.number(), endSeconds: z.number() }).nullable(),
  firstHandConfirmation: z
    .strictObject({ userId: id, confirmedAt: time, materialVersion: z.int().positive() })
    .nullable(),
});
export const ResearchEvidenceSchema = z.strictObject({
  id,
  sourceId: id,
  materialId: id,
  excerpt: text,
  directness: z.enum(['direct', 'indirect']),
  locator: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('text'),
      startOffset: z.int().nonnegative(),
      endOffset: z.int().positive(),
    }),
    z.strictObject({
      kind: z.literal('video'),
      startSeconds: z.number(),
      endSeconds: z.number(),
    }),
    z.strictObject({
      kind: z.literal('frame'),
      frameAssetId: id,
      timeSeconds: z.number().nonnegative(),
    }),
  ]),
});
export const ResearchClaimSchema = z.strictObject({
  id,
  kind: z.enum(['fact', 'third_party_opinion', 'inference']),
  statement: text,
  attribution: text.nullable(),
  evidenceIds: z.array(id),
  refutingEvidenceIds: z.array(id),
  premiseClaimIds: z.array(id),
  questionIds: z.array(id).min(1),
  limitations: z.array(text),
});
export const ResearchGapSchema = z.strictObject({
  id,
  questionIds: z.array(id),
  sectionIds: z.array(id),
  severity: EvidenceSeveritySchema,
  claim: text,
  impact: text,
  requestedMaterial: text,
});
export const ResearchWarningSchema = z.strictObject({
  code: text,
  message: text,
  relatedRefs: z.array(id),
});
export const ResearchReportSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  status: z.enum(['completed', 'partial']),
  summary: text,
  questions: z
    .array(
      ResearchQuestionSchema.extend({
        origin: z.enum(['supervisor', 'research']),
        status: z.enum(['answered', 'partial', 'unanswered']),
        claimIds: z.array(id),
        gapIds: z.array(id),
      }),
    )
    .min(1),
  claims: z.array(ResearchClaimSchema),
  sections: z
    .array(
      z.strictObject({
        id,
        title: text,
        requirementRef: id,
        status: z.enum(['supported', 'insufficient_evidence']),
        claimIds: z.array(id),
        gapIds: z.array(id),
      }),
    )
    .min(1),
  evidence: z.array(ResearchEvidenceSchema),
  gaps: z.array(ResearchGapSchema),
  conflicts: z.array(
    z.strictObject({
      id,
      description: text,
      evidenceIds: z.array(id).min(2),
      resolution: text.nullable(),
      gapId: id.nullable(),
    }),
  ),
  suggestedAngles: z.array(
    z.strictObject({ angle: text, claimIds: z.array(id).min(1), limitations: z.array(text) }),
  ),
  warnings: z.array(ResearchWarningSchema),
  changes: z.array(
    z.strictObject({
      kind: z.enum(['added', 'revised', 'retracted', 'gap_opened', 'gap_resolved', 'gap_changed']),
      previousRef: id.nullable(),
      currentRef: id.nullable(),
      reason: text,
    }),
  ),
});
export const ResearchToolAttemptSchema = z.strictObject({
  id,
  toolUseId: id,
  toolName: text,
  site: ResearchSiteSchema.nullable(),
  query: text.nullable(),
  sourceId: id.nullable(),
  status: z.enum(['succeeded', 'failed', 'no_results']),
  errorCode: text.nullable(),
  startedAt: time,
  finishedAt: time,
});
export const ResearchMetadataSchema = z.strictObject({
  promptVersion: text,
  toolPolicyVersion: text,
  configVersion: z.int().positive(),
  skills: z.array(z.strictObject({ name: text, version: text })),
  traceId: id.nullable(),
  parentToolUseId: id.nullable(),
  durationMs: z.number().nonnegative(),
});
const resultIdentity = {
  id,
  version: z.int().positive(),
  parentResultId: id.nullable(),
  execution: ExecutionRefSchema,
  authorizationId: id,
  selectedProject: SelectedProjectSchema,
};
/** Host-owned envelope. Model output alone can never manufacture this accepted result. */
export const ResearchAcceptedResultSchema = z.strictObject({
  ...resultIdentity,
  report: ResearchReportSchema,
  sources: z.array(ResearchSourceSchema),
  materials: z.array(ResearchMaterialSchema),
  toolAttempts: z.array(ResearchToolAttemptSchema),
  metadata: ResearchMetadataSchema,
});
export const ResearchRuntimeContextSchema = z.strictObject({
  now: time,
  timezone: text,
  skills: z.array(
    z.strictObject({
      name: text,
      version: text,
      requiredSections: z.array(z.strictObject({ id, title: text })),
    }),
  ),
  requiredSearchSites: z.array(ResearchSiteSchema),
  toolPolicyVersion: text,
  configVersion: z.int().positive(),
  limits: z.strictObject({
    timeoutMs: z.int().positive(),
    maxSearchCalls: z.int().nonnegative(),
    maxFetchCalls: z.int().nonnegative(),
    maxVideoCalls: z.int().nonnegative(),
    maxOutputAttempts: z.int().positive(),
    maxBudgetUsd: z.number().nonnegative(),
  }),
});
/** Host-provided data used to construct a child's context. These fields grant no permission. */
export const ResearchInputsSchema = z.strictObject({
  stepId: id,
  mode: ResearchModeSchema,
  contentContext: z.strictObject({
    audience: text,
    purpose: text,
    platform: z.literal('douyin'),
    format: z.literal('image_text'),
    prohibitions: z.array(text),
  }),
  referenceMaterials: z.strictObject({
    sources: z.array(ResearchSourceSchema),
    materials: z.array(ResearchMaterialSchema),
  }),
  supplementScope: z
    .strictObject({ questionIds: z.array(id).min(1), gapIds: z.array(id) })
    .nullable(),
  runtimeContext: ResearchRuntimeContextSchema,
});
export const ResearchContextSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  execution: ExecutionRefSchema,
  authorization: z.strictObject({ id, mode: ResearchModeSchema }),
  selectedProject: SelectedProjectSchema,
  request: ResearchRequestSchema,
  contentContext: ResearchInputsSchema.shape.contentContext,
  referenceMaterials: ResearchInputsSchema.shape.referenceMaterials,
  previousReport: ResearchAcceptedResultSchema.nullable(),
  supplementScope: ResearchInputsSchema.shape.supplementScope,
  runtimeContext: ResearchRuntimeContextSchema,
});
export const ResearchRunResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('reported'), result: ResearchAcceptedResultSchema }),
  z.strictObject({
    outcome: z.enum(['failed', 'cancelled']),
    execution: ExecutionRefSchema,
    authorizationId: id,
    report: z.null(),
    toolAttempts: z.array(ResearchToolAttemptSchema),
    error: z.strictObject({ code: text, message: text }),
  }),
]);
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;
export type GithubHotList = z.infer<typeof GithubHotListSchema>;
export type SelectedProject = z.infer<typeof SelectedProjectSchema>;
export type ResearchContext = z.infer<typeof ResearchContextSchema>;
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
export type ResearchAcceptedResult = z.infer<typeof ResearchAcceptedResultSchema>;
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;
export type ResearchGap = z.infer<typeof ResearchGapSchema>;
export type ResearchInputs = z.infer<typeof ResearchInputsSchema>;
export type ResearchRunResult = z.infer<typeof ResearchRunResultSchema>;
