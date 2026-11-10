import { z } from 'zod';

const id = z.string().min(1).max(256).regex(/\S/);

/** Model input. Execution identity, URLs, paths and credentials come from the host. */
export const FetchVideoInputSchema = z.strictObject({ sourceId: id });

export const FetchVideoErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'CONFIGURATION_INVALID',
  'SOURCE_NOT_FOUND',
  'SOURCE_NOT_AUTHORIZED',
  'PLATFORM_NOT_ENABLED',
  'URL_NOT_ALLOWED',
  'NETWORK_SCOPE_DENIED',
  'AUTH_REQUIRED',
  'SOURCE_UNAVAILABLE',
  'NETWORK_ERROR',
  'DEPENDENCY_UNAVAILABLE',
  'DOWNLOAD_FAILED',
  'INVALID_MEDIA',
  'STORAGE_ERROR',
  'RESOURCE_BUSY',
  'TIMEOUT',
  'CANCELLED',
]);

export const FetchVideoResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('succeeded'),
    sourceId: id,
    videoAssetId: id,
    platform: z.enum(['bilibili', 'xiaohongshu']),
    durationSeconds: z.number().positive().finite(),
    sizeBytes: z.int().positive(),
    width: z.int().positive(),
    height: z.int().positive(),
    container: z.enum(['mp4', 'mkv', 'webm']),
    hasAudio: z.literal(true),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.iso.datetime(),
    reused: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('failed'),
    sourceId: id.nullable(),
    code: FetchVideoErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);

export type FetchVideoInput = z.infer<typeof FetchVideoInputSchema>;
export type FetchVideoResult = z.infer<typeof FetchVideoResultSchema>;
export type FetchVideoErrorCode = z.infer<typeof FetchVideoErrorCodeSchema>;
