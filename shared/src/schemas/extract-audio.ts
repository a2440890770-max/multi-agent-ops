import { z } from 'zod';

const id = z.string().min(1).max(256).regex(/\S/);

/** Only registered videos; paths, ranges, tracks and encoder options are host-controlled. */
export const ExtractAudioInputSchema = z.strictObject({ videoAssetId: id });

export const ExtractAudioErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'CONFIGURATION_INVALID',
  'VIDEO_NOT_FOUND',
  'SOURCE_NOT_AUTHORIZED',
  'INVALID_MEDIA',
  'NO_AUDIO',
  'TIMELINE_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'EXTRACTION_FAILED',
  'INVALID_AUDIO',
  'STORAGE_ERROR',
  'TIMEOUT',
  'CANCELLED',
]);

export const ExtractAudioSucceededSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  status: z.literal('succeeded'),
  audioAssetId: id,
  videoAssetId: id,
  sourceId: id,
  selectedAudioStreamIndex: z.int().nonnegative(),
  format: z.literal('wav'),
  codec: z.literal('pcm_s16le'),
  sampleRateHz: z.literal(16000),
  channels: z.literal(1),
  durationSeconds: z.number().positive().finite(),
  sizeBytes: z.int().positive(),
  sourceTimeOffsetSeconds: z.number().finite(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extractedAt: z.iso.datetime(),
  reused: z.boolean(),
});

export const ExtractAudioResultSchema = z.discriminatedUnion('status', [
  ExtractAudioSucceededSchema,
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('failed'),
    videoAssetId: id.nullable(),
    code: ExtractAudioErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);

export type ExtractAudioInput = z.infer<typeof ExtractAudioInputSchema>;
export type ExtractAudioResult = z.infer<typeof ExtractAudioResultSchema>;
export type ExtractAudioSucceeded = z.infer<typeof ExtractAudioSucceededSchema>;
export type ExtractAudioErrorCode = z.infer<typeof ExtractAudioErrorCodeSchema>;
