import { z } from 'zod';

const id = z.string().min(1).max(256).regex(/\S/);
const time = z.number().nonnegative().finite();
export const ExtractFramesInputSchema = z
  .strictObject({
    videoAssetId: id,
    count: z.int().positive().optional(),
    timestampsSeconds: z.array(time).min(1).optional(),
  })
  .refine((value) => value.count === undefined || value.timestampsSeconds === undefined, {
    message: 'count 与 timestampsSeconds 不能同时指定。',
  });
export const ExtractFramesErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'CONFIGURATION_INVALID',
  'VIDEO_NOT_FOUND',
  'SOURCE_NOT_AUTHORIZED',
  'INVALID_MEDIA',
  'NO_VIDEO',
  'TIMELINE_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'EXTRACTION_FAILED',
  'INVALID_FRAME',
  'STORAGE_ERROR',
  'TIMEOUT',
  'CANCELLED',
]);
export const ExtractedFrameSchema = z.strictObject({
  frameAssetId: id,
  sourceFrameIndex: z.int().nonnegative(),
  sourcePts: z.int(),
  actualTimeSeconds: time,
  format: z.literal('png'),
  width: z.int().positive().max(1920),
  height: z.int().positive().max(1920),
  sizeBytes: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const requestSchema = z.discriminatedUnion('status', [
  z.strictObject({
    requestIndex: z.int().nonnegative(),
    requestedTimeSeconds: time,
    status: z.literal('succeeded'),
    frameAssetId: id,
  }),
  z.strictObject({
    requestIndex: z.int().nonnegative(),
    requestedTimeSeconds: time,
    status: z.literal('failed'),
    code: z.enum(['EXTRACTION_FAILED', 'INVALID_FRAME']),
    message: z.string().min(1),
  }),
]);
export const ExtractFramesAvailableSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.enum(['succeeded', 'partial']),
    frameSetId: id,
    videoAssetId: id,
    sourceId: id,
    samplingMode: z.enum(['uniform', 'timestamps']),
    requestedCount: z.int().positive(),
    selectedVideoStreamIndex: z.int().nonnegative(),
    videoDurationSeconds: z.number().positive().finite(),
    videoStartTimeSeconds: z.number().finite(),
    timeBaseNumerator: z.int().positive(),
    timeBaseDenominator: z.int().positive(),
    inputScope: z.literal('sampled_frames'),
    analysisPerformed: z.literal(false),
    frames: z.array(ExtractedFrameSchema).min(1),
    requests: z.array(requestSchema).min(1),
    warnings: z.array(
      z.strictObject({
        code: z.enum([
          'SAMPLED_FRAMES_ONLY',
          'DUPLICATE_FRAME_MATCHES',
          'PARTIAL_EXTRACTION',
          'ENCODER_REPORTED_ERROR',
        ]),
        message: z.string().min(1),
      }),
    ),
    extractedAt: z.iso.datetime(),
    reused: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    const byId = new Map(value.frames.map((frame) => [frame.frameAssetId, frame]));
    const used = new Set<string>();
    const indices = new Set<number>();
    let failures = 0;
    if (value.requests.length !== value.requestedCount || byId.size !== value.frames.length)
      reject('帧数、请求数或资源标识不一致。');
    for (const frame of value.frames) {
      if (
        indices.has(frame.sourceFrameIndex) ||
        frame.actualTimeSeconds >= value.videoDurationSeconds ||
        Math.abs(
          (frame.sourcePts * value.timeBaseNumerator) / value.timeBaseDenominator -
            value.videoStartTimeSeconds -
            frame.actualTimeSeconds,
        ) > 1e-6
      )
        reject('帧时间映射或去重结果无效。');
      indices.add(frame.sourceFrameIndex);
    }
    for (const [index, request] of value.requests.entries()) {
      if (
        request.requestIndex !== index ||
        request.requestedTimeSeconds >= value.videoDurationSeconds
      )
        reject('采样请求索引或时间范围无效。');
      if (request.status === 'failed') failures++;
      else {
        if (!byId.has(request.frameAssetId)) reject('采样请求引用了不存在的帧。');
        used.add(request.frameAssetId);
      }
    }
    const warnings = value.warnings.map((warning) => warning.code);
    if (
      used.size !== value.frames.length ||
      failures > 0 !== (value.status === 'partial') ||
      !warnings.includes('SAMPLED_FRAMES_ONLY') ||
      new Set(warnings).size !== warnings.length ||
      warnings.includes('PARTIAL_EXTRACTION') !== failures > 0 ||
      warnings.includes('DUPLICATE_FRAME_MATCHES') !==
        value.requests.length - failures > value.frames.length
    )
      reject('采样覆盖范围、状态或警告不一致。');
  });
export const ExtractFramesResultSchema = z.discriminatedUnion('status', [
  ExtractFramesAvailableSchema,
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('failed'),
    videoAssetId: id.nullable(),
    code: ExtractFramesErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
export type ExtractFramesInput = z.infer<typeof ExtractFramesInputSchema>;
export type ExtractFramesResult = z.infer<typeof ExtractFramesResultSchema>;
export type ExtractFramesAvailable = z.infer<typeof ExtractFramesAvailableSchema>;
export type ExtractFramesErrorCode = z.infer<typeof ExtractFramesErrorCodeSchema>;
export type ExtractedFrame = z.infer<typeof ExtractedFrameSchema>;
