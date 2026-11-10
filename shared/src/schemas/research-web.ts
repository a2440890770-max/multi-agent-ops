import { z } from 'zod';
import {
  ExecutionRefSchema,
  ResearchMaterialSchema,
  ResearchSourceSchema,
  ResearchSiteSchema,
  SelectedProjectSchema,
} from './research.js';

const id = z.string().min(1).regex(/\S/);
const time = z.iso.datetime({ offset: true });
export const ResearchWebConfigSchema = z.strictObject({
  root: id,
  maxSearchCalls: z.int().nonnegative(),
  maxFetchCalls: z.int().nonnegative(),
  maxSearchResults: z.int().positive(),
  timeoutMs: z.int().positive(),
  maxResponseBytes: z.int().positive(),
  maxTextCharacters: z.int().positive(),
  maxRedirects: z.int().nonnegative(),
});
export const OfficialSiteGrantSchema = z.strictObject({
  origin: z.url(),
  pathPrefix: z.string().startsWith('/'),
  approvedBy: z.enum(['configuration', 'user_confirmation']),
  approvalRef: id,
});
export const ResearchWebCallSchema = z.strictObject({
  id,
  toolUseId: id,
  toolName: z.enum(['WebSearch', 'WebFetch']),
  query: z.string().nullable(),
  site: ResearchSiteSchema.nullable(),
  sourceId: id.nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'no_results', 'denied']),
  errorCode: id.nullable(),
  startedAt: time,
  finishedAt: time.nullable(),
  deadlineAt: time,
  countsTowardLimit: z.boolean(),
  sdkNetworkAttempts: z.literal('unobserved'),
  sourceIds: z.array(id),
  materialIds: z.array(id),
});
export const ResearchWebSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  execution: ExecutionRefSchema,
  authorizationId: id,
  selectedProject: SelectedProjectSchema,
  policy: z.strictObject({
    version: z.literal('research-web-d9-v1'),
    config: ResearchWebConfigSchema,
    officialSites: z.array(OfficialSiteGrantSchema),
  }),
  sources: z.array(
    z.strictObject({
      source: ResearchSourceSchema,
      discoveredBy: z.enum(['project', 'input', 'history', 'search', 'document_link']),
      parentSourceId: id.nullable(),
      toolUseId: id.nullable(),
    }),
  ),
  materials: z.array(
    z.strictObject({
      material: ResearchMaterialSchema,
      method: z.enum(['provided', 'search_snippet', 'sdk_processed', 'independent_body']),
      contentSha256: id,
      responseSha256: id.nullable(),
      finalUrl: z.url().nullable(),
      redirects: z.array(z.url()),
      toolUseId: id.nullable(),
      extractionVersion: id,
      textOffset: z.int().nonnegative().nullable(),
    }),
  ),
  calls: z.array(ResearchWebCallSchema),
});
export type ResearchWebConfig = z.infer<typeof ResearchWebConfigSchema>;
export type OfficialSiteGrant = z.infer<typeof OfficialSiteGrantSchema>;
export type ResearchWebCall = z.infer<typeof ResearchWebCallSchema>;
export type ResearchWebSnapshot = z.infer<typeof ResearchWebSnapshotSchema>;
