import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AudioError, type ExtractAudioConfig } from './types.js';

const configSchema = z.strictObject({
  ffmpegPath: z.string().refine((value) => value === 'ffmpeg' || isAbsolute(value)),
  ffprobePath: z.string().refine((value) => value === 'ffprobe' || isAbsolute(value)),
  mediaRoot: z.string().refine(isAbsolute),
  timeoutMs: z.int().min(1).max(2_147_481_000),
});

export function validateExtractAudioConfig(value: unknown): ExtractAudioConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success)
    throw new AudioError('CONFIGURATION_INVALID', '音频提取工具的后端配置无效。');
  return parsed.data;
}

export function readExtractAudioConfig(env: NodeJS.ProcessEnv = process.env): ExtractAudioConfig {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return validateExtractAudioConfig({
    ffmpegPath:
      env.EXTRACT_AUDIO_FFMPEG_PATH?.trim() || env.FETCH_VIDEO_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath:
      env.EXTRACT_AUDIO_FFPROBE_PATH?.trim() || env.FETCH_VIDEO_FFPROBE_PATH?.trim() || 'ffprobe',
    mediaRoot: resolve(root, env.FETCH_VIDEO_ROOT?.trim() || 'artifacts/media'),
    timeoutMs: Number(env.EXTRACT_AUDIO_TIMEOUT_MS || 600_000),
  });
}
