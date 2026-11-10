import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FramesError, type ExtractFramesConfig } from './types.js';

const configSchema = z
  .strictObject({
    ffmpegPath: z.string().refine((value) => value === 'ffmpeg' || isAbsolute(value)),
    ffprobePath: z.string().refine((value) => value === 'ffprobe' || isAbsolute(value)),
    mediaRoot: z.string().refine(isAbsolute),
    timeoutMs: z.int().min(1).max(2_147_481_000),
    defaultCount: z.int().positive(),
    maxFrames: z.int().positive(),
    maxLongEdge: z.int().min(1).max(1920),
  })
  .refine((value) => value.defaultCount <= value.maxFrames);
export function validateExtractFramesConfig(value: unknown): ExtractFramesConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success)
    throw new FramesError(
      'CONFIGURATION_INVALID',
      '抽帧工具的后端配置无效，默认数量不能超过数量上限。',
    );
  return parsed.data;
}
export function readExtractFramesConfig(env: NodeJS.ProcessEnv = process.env): ExtractFramesConfig {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return validateExtractFramesConfig({
    ffmpegPath:
      env.EXTRACT_FRAMES_FFMPEG_PATH?.trim() || env.FETCH_VIDEO_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath:
      env.EXTRACT_FRAMES_FFPROBE_PATH?.trim() || env.FETCH_VIDEO_FFPROBE_PATH?.trim() || 'ffprobe',
    mediaRoot: resolve(root, env.FETCH_VIDEO_ROOT?.trim() || 'artifacts/media'),
    timeoutMs: Number(env.EXTRACT_FRAMES_TIMEOUT_MS || 600_000),
    defaultCount: Number(env.EXTRACT_FRAMES_DEFAULT_COUNT || 12),
    maxFrames: Number(env.EXTRACT_FRAMES_MAX_FRAMES || 30),
    maxLongEdge: Number(env.EXTRACT_FRAMES_MAX_LONG_EDGE || 1920),
  });
}
