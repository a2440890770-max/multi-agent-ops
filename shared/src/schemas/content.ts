import { z } from 'zod';

const text = z.string().min(1).max(20000).regex(/\S/);
const id = text;
const positive = z.int().positive();
const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:');

export const ContentPlanSchema = z.strictObject({
  title: text,
  cover: z.strictObject({ headline: text, subtitle: text.nullable(), visualBrief: text }),
  pages: z
    .array(z.strictObject({ key: id, heading: text, body: text, visualBrief: text }))
    .min(1)
    .max(20),
  caption: text,
  hashtags: z.array(text).max(20),
  projectUrl: httpsUrl,
  productionNotes: z.array(text),
});

/** Validated projection of an accepted Research result, not the raw Research report. */
export const ContentResearchSchema = z.strictObject({
  id,
  projectId: id,
  sources: z.array(
    z.strictObject({ id, url: httpsUrl.nullable(), label: text, locator: text, excerpt: text }),
  ),
  facts: z.array(
    z.strictObject({
      id,
      statement: text,
      kind: z.enum(['fact', 'attributed_opinion', 'inference']),
      sourceIds: z.array(id).min(1),
      // Exact attribution/qualification which must survive in public claims.
      requiredQualifier: text.nullable(),
    }),
  ),
  gaps: z.array(
    z.strictObject({ id, severity: z.enum(['core', 'noncritical']), description: text }),
  ),
  exclusions: z.array(text),
});

const issueSchema = z.strictObject({
  id,
  kind: z.enum(['deterministic', 'factual', 'subjective']),
  fieldPath: text,
  message: text,
  suggestion: text,
});

/** Built by the backend after checking ownership and live execution authority. */
export const ContentContextSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  execution: z.strictObject({
    taskId: id,
    attemptId: id,
    stepId: id,
    inputSnapshotId: id,
    epoch: positive,
  }),
  controlMode: z.enum(['automatic', 'human']),
  project: z.strictObject({ id, selectionId: id, repository: text, url: httpsUrl }),
  requirements: z.strictObject({
    revision: positive,
    objective: text,
    audience: text,
    tone: text,
    constraints: z.array(text),
    prohibitions: z.array(text),
  }),
  // These are task-specific editorial settings, not asserted platform limits.
  format: z.strictObject({
    pageCount: positive.max(20).nullable(),
    titleMaxChars: positive.nullable(),
    pageBodyMaxChars: positive.nullable(),
  }),
  research: ContentResearchSchema,
  usableFactIds: z.array(id).min(1),
  skill: z.strictObject({ id, version: id }),
  revision: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('initial'), autoRevisionCount: z.literal(0) }),
    z.strictObject({
      mode: z.literal('revise'),
      // The executor reserves this round atomically, including across retries.
      autoRevisionCount: z.int().min(1).max(3),
      roundId: id,
      parentVersionId: id,
      parentPlan: ContentPlanSchema,
      reviewId: id,
      reviewedVersionId: id,
      issues: z.array(issueSchema).min(1),
    }),
  ]),
});

export const ContentOutputSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('draft'),
    summary: text,
    plan: ContentPlanSchema,
    claimRefs: z
      .array(
        z.strictObject({
          fieldPath: text,
          claim: text,
          kind: z.enum(['fact', 'attributed_opinion', 'inference']),
          factIds: z.array(id).min(1),
          sourceIds: z.array(id).min(1),
        }),
      )
      .min(1),
    changeResponses: z.array(
      z.strictObject({
        issueId: id,
        action: z.enum(['addressed', 'unresolved']),
        fieldPaths: z.array(text).min(1),
        reason: text,
      }),
    ),
    warnings: z.array(text),
    defaultsUsed: z.array(z.strictObject({ field: text, value: text, reason: text })),
  }),
  z.strictObject({
    decision: z.literal('needs_materials'),
    summary: text,
    gapIds: z.array(id).min(1),
    requests: z.array(text).min(1),
  }),
  z.strictObject({
    decision: z.literal('blocked'),
    code: z.enum(['new_evidence_gap', 'research_inconsistent', 'requirements_conflict']),
    summary: text,
    requests: z.array(text).min(1),
  }),
]);

export type ContentPlan = z.infer<typeof ContentPlanSchema>;
export type ContentContext = z.infer<typeof ContentContextSchema>;
export type ContentOutput = z.infer<typeof ContentOutputSchema>;
