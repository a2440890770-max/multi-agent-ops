import { z } from 'zod';
import type { SourceRef } from '../domain.js';

// Keep these schemas JSON Schema compatible for SDK outputFormat. IDs are opaque.
const nonBlankText = z.string().min(1).regex(/\S/, 'Must contain non-whitespace text');
const id = nonBlankText;
const sourceRefSchema = z.strictObject({
  id,
  label: nonBlankText,
  url: z.url().nullable(),
}) satisfies z.ZodType<SourceRef>;

/** Backend-built D9 input snapshot; it cannot grant tools or replace live execution checks. */
export const SupervisorContextSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  execution: z.strictObject({
    taskId: id,
    attemptId: id,
    stepId: id,
    inputSnapshotId: id,
  }),
  trigger: z.enum([
    'task_started',
    'clarification_answered',
    'materials_added',
    'additional_research_authorized',
  ]),
  task: z.strictObject({
    title: nonBlankText,
    originalRequest: nonBlankText,
    referenceInputs: z.array(sourceRefSchema),
  }),
  clarifications: z.array(
    z.strictObject({
      questionId: id,
      question: nonBlankText,
      answer: nonBlankText.nullable(),
    }),
  ),
  accountContext: z.strictObject({
    accountId: id.nullable(),
    description: nonBlankText.nullable(),
    defaultAudience: nonBlankText.nullable(),
    defaultTone: nonBlankText.nullable(),
    prohibitions: z.array(nonBlankText),
  }),
  memoryContext: z.array(
    z.strictObject({
      id,
      version: z.int().positive(),
      content: nonBlankText,
    }),
  ),
  researchContext: z.strictObject({
    authorizationId: id.nullable(),
    authorizationUsed: z.boolean(),
    // Validated, persisted Research results; their payload contract is defined separately.
    acceptedResultIds: z.array(id),
  }),
  runtimePolicy: z.strictObject({
    stage: z.literal('D9'),
    allowedSubagents: z.array(z.literal('research')),
    configVersion: z.int().positive(),
    promptVersion: nonBlankText,
    toolPolicyVersion: nonBlankText,
  }),
  contextSelection: z.strictObject({
    includedRefs: z.array(id),
    omitted: z.array(
      z.strictObject({
        ref: id,
        reason: nonBlankText,
      }),
    ),
  }),
});

const outputCommon = {
  summary: nonBlankText,
  basisRefs: z.array(id),
  defaultsUsed: z.array(
    z.strictObject({
      field: z.enum(['audience', 'tone']),
      value: nonBlankText,
      basis: z.enum(['account_configuration', 'reasonable_default']),
    }),
  ),
  warnings: z.array(
    z.strictObject({
      code: nonBlankText,
      message: nonBlankText,
      relatedRefs: z.array(id),
    }),
  ),
};

/**
 * Model decisions only. Failures, cancellation, IDs, versions and Trace metadata are
 * recorded by the executor. It must also validate reference ownership, accepted
 * Research results, unresolved core evidence gaps and live execution authority.
 */
export const SupervisorOutputSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...outputCommon,
    decision: z.literal('needs_clarification'),
    questions: z
      .array(
        z.strictObject({
          kind: z.enum(['missing_requirement', 'conflicting_requirements']),
          question: nonBlankText,
          reason: nonBlankText,
        }),
      )
      .min(1),
  }),
  z.strictObject({
    ...outputCommon,
    decision: z.literal('needs_materials'),
    researchResultId: id,
    blockingGaps: z
      .array(
        z.strictObject({
          researchGapId: id,
          impact: nonBlankText,
          requestedMaterial: nonBlankText,
        }),
      )
      .min(1),
  }),
  z.strictObject({
    ...outputCommon,
    decision: z.literal('ready_for_content'),
    researchResultId: id,
    contentBrief: z.strictObject({
      topic: nonBlankText,
      objective: nonBlankText,
      constraints: z.array(nonBlankText),
      usableFactIds: z.array(id),
      exclusions: z.array(
        z.strictObject({
          researchGapId: id,
          omittedClaim: nonBlankText,
          reason: nonBlankText,
        }),
      ),
    }),
  }),
]);

export type SupervisorContext = z.infer<typeof SupervisorContextSchema>;
export type SupervisorOutput = z.infer<typeof SupervisorOutputSchema>;
