import { z } from 'zod';

export const draftResultSchema = z.strictObject({ body: z.string().min(1).max(20000) });
export const reviewResultSchema = z.strictObject({
  outcome: z.enum(['pass', 'changes_required', 'manual_required']),
  checks: z.array(z.string().min(1)).min(1).max(30),
  suggestions: z.array(z.string().min(1)).max(30),
  scores: z
    .array(z.strictObject({ name: z.string().min(1), value: z.number().min(0).max(100) }))
    .min(1)
    .max(10),
  blockingIssues: z
    .array(
      z.strictObject({
        kind: z.enum(['deterministic', 'factual', 'subjective']),
        message: z.string().min(1),
      }),
    )
    .max(30),
  factualEvidenceSufficient: z.boolean(),
  hasFactualClaims: z.boolean(),
  // Every factual claim must be covered; IDs and verbatim excerpts are checked again by the backend.
  facts: z
    .array(
      z.strictObject({
        claim: z.string().min(1),
        sourceId: z.string().min(1),
        quote: z.string().min(1),
      }),
    )
    .max(50),
});
export type DraftResult = z.infer<typeof draftResultSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export const workflowInputSchema = z.strictObject({
  role: z.enum(['content', 'review']),
  request: z.string().min(1).max(20000),
  body: z.string().max(20000),
  round: z.number().int().min(0).max(3),
  suggestions: z.array(z.string()).max(100),
  sources: z.array(z.strictObject({ id: z.string(), text: z.string().max(20000) })).max(30),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
