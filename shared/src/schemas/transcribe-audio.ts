import { z } from 'zod';

const id = z.string().min(1).max(256).regex(/\S/);
/** Language codes exposed by the installed whisper.cpp 1.9.5 language API. */
export const TranscriptionLanguageSchema = z.enum([
  'en',
  'zh',
  'de',
  'es',
  'ru',
  'ko',
  'fr',
  'ja',
  'pt',
  'tr',
  'pl',
  'ca',
  'nl',
  'ar',
  'sv',
  'it',
  'id',
  'hi',
  'fi',
  'vi',
  'he',
  'uk',
  'el',
  'ms',
  'cs',
  'ro',
  'da',
  'hu',
  'ta',
  'no',
  'th',
  'ur',
  'hr',
  'bg',
  'lt',
  'la',
  'mi',
  'ml',
  'cy',
  'sk',
  'te',
  'fa',
  'lv',
  'bn',
  'sr',
  'az',
  'sl',
  'kn',
  'et',
  'mk',
  'br',
  'eu',
  'is',
  'hy',
  'ne',
  'mn',
  'bs',
  'kk',
  'sq',
  'sw',
  'gl',
  'mr',
  'pa',
  'si',
  'km',
  'sn',
  'yo',
  'so',
  'af',
  'oc',
  'ka',
  'be',
  'tg',
  'sd',
  'gu',
  'am',
  'yi',
  'lo',
  'uz',
  'fo',
  'ht',
  'ps',
  'tk',
  'nn',
  'mt',
  'sa',
  'lb',
  'my',
  'bo',
  'tl',
  'mg',
  'as',
  'tt',
  'haw',
  'ln',
  'ha',
  'ba',
  'jw',
  'su',
  'yue',
]);
export const TranscriptionRequestedLanguageSchema = z.union([
  z.literal('auto'),
  TranscriptionLanguageSchema,
]);
export const TranscribeAudioInputSchema = z.strictObject({
  audioAssetId: id,
  language: TranscriptionRequestedLanguageSchema.optional(),
});

export const TranscribeAudioErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'CONFIGURATION_INVALID',
  'AUDIO_NOT_FOUND',
  'SOURCE_NOT_AUTHORIZED',
  'MODEL_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'PROCESS_TERMINATED',
  'TRANSCRIPTION_FAILED',
  'INVALID_OUTPUT',
  'STORAGE_ERROR',
  'TIMEOUT',
  'CANCELLED',
]);
export const TranscriptionWarningSchema = z.strictObject({
  code: z.enum([
    'ASR_UNVERIFIED',
    'TIMESTAMPS_ESTIMATED',
    'NO_TEXT_RECOGNIZED',
    'TIMESTAMP_BOUNDARY_ADJUSTED',
  ]),
  message: z.string().min(1),
});
export const TranscriptionSegmentSchema = z.strictObject({
  id,
  text: z.string().min(1).regex(/\S/),
  audioStartSeconds: z.number().nonnegative().finite(),
  audioEndSeconds: z.number().nonnegative().finite(),
  videoStartSeconds: z.number().finite(),
  videoEndSeconds: z.number().finite(),
});
export const TranscribeAudioSucceededSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('succeeded'),
    transcriptAssetId: id,
    audioAssetId: id,
    videoAssetId: id,
    sourceId: id,
    engine: z.literal('whisper.cpp'),
    engineVersion: z.string().min(1).max(64),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    requestedLanguage: TranscriptionRequestedLanguageSchema,
    detectedLanguage: TranscriptionLanguageSchema.nullable(),
    inputScope: z.literal('entire_audio'),
    durationSeconds: z.number().positive().finite(),
    sourceTimeOffsetSeconds: z.number().finite(),
    text: z.string(),
    segments: z.array(TranscriptionSegmentSchema),
    empty: z.boolean(),
    warnings: z.array(TranscriptionWarningSchema),
    transcribedAt: z.iso.datetime(),
    reused: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      value.empty !== (value.segments.length === 0) ||
      value.text !== value.segments.map((segment) => segment.text).join('\n')
    )
      reject('转写正文与分段或空结果标记不一致。');
    const warnings = value.warnings.map((warning) => warning.code);
    if (
      new Set(warnings).size !== warnings.length ||
      !warnings.includes('ASR_UNVERIFIED') ||
      !warnings.includes('TIMESTAMPS_ESTIMATED') ||
      warnings.includes('NO_TEXT_RECOGNIZED') !== value.empty
    )
      reject('转写必须保留准确且不重复的质量与空结果警告。');
    if (
      (!value.empty && value.detectedLanguage === null) ||
      (value.requestedLanguage !== 'auto' && value.detectedLanguage !== value.requestedLanguage)
    )
      reject('转写语言与请求或实际结果不一致。');
    const ids = new Set<string>();
    let previousStart = 0;
    let previousEnd = 0;
    for (const segment of value.segments) {
      if (
        ids.has(segment.id) ||
        segment.audioStartSeconds < previousStart ||
        segment.audioEndSeconds < previousEnd ||
        segment.audioEndSeconds <= segment.audioStartSeconds ||
        segment.audioEndSeconds > value.durationSeconds ||
        Math.abs(
          segment.videoStartSeconds - segment.audioStartSeconds - value.sourceTimeOffsetSeconds,
        ) > 1e-6 ||
        Math.abs(
          segment.videoEndSeconds - segment.audioEndSeconds - value.sourceTimeOffsetSeconds,
        ) > 1e-6
      )
        reject('转写分段顺序、时间范围或原视频时间映射无效。');
      ids.add(segment.id);
      previousStart = segment.audioStartSeconds;
      previousEnd = segment.audioEndSeconds;
    }
  });
export const TranscribeAudioResultSchema = z.discriminatedUnion('status', [
  TranscribeAudioSucceededSchema,
  z.strictObject({
    schemaVersion: z.literal('1.0'),
    status: z.literal('failed'),
    audioAssetId: id.nullable(),
    code: TranscribeAudioErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);

export type TranscribeAudioInput = z.infer<typeof TranscribeAudioInputSchema>;
export type TranscribeAudioResult = z.infer<typeof TranscribeAudioResultSchema>;
export type TranscribeAudioSucceeded = z.infer<typeof TranscribeAudioSucceededSchema>;
export type TranscribeAudioErrorCode = z.infer<typeof TranscribeAudioErrorCodeSchema>;
export type TranscriptionWarning = z.infer<typeof TranscriptionWarningSchema>;
