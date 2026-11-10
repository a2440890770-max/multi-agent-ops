import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { VideoError, type FetchVideoConfig } from './types.js';

const configSchema = z.strictObject({
  ytDlpPath: z.string().min(1),
  ffmpegPath: z.string().refine((value) => value === 'ffmpeg' || isAbsolute(value)),
  ffprobePath: z.string().min(1),
  mediaRoot: z.string().refine(isAbsolute),
  chromeProfile: z.string().regex(/^(Default|Profile [0-9]+)$/),
  timeoutMs: z.int().min(1).max(2_147_481_000),
  maxResolution: z.int().min(1).max(4320),
});

export function validateFetchVideoConfig(value: unknown): FetchVideoConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new VideoError('CONFIGURATION_INVALID', '视频工具的后端配置无效。');
  return parsed.data;
}

export function readFetchVideoConfig(env: NodeJS.ProcessEnv = process.env): FetchVideoConfig {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return validateFetchVideoConfig({
    ytDlpPath: env.FETCH_VIDEO_YTDLP_PATH?.trim() || 'yt-dlp',
    ffmpegPath: env.FETCH_VIDEO_FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FETCH_VIDEO_FFPROBE_PATH?.trim() || 'ffprobe',
    mediaRoot: resolve(root, env.FETCH_VIDEO_ROOT?.trim() || 'artifacts/media'),
    chromeProfile: env.FETCH_VIDEO_CHROME_PROFILE?.trim() || 'Default',
    timeoutMs: Number(env.FETCH_VIDEO_TIMEOUT_MS || 600_000),
    maxResolution: Number(env.FETCH_VIDEO_MAX_RESOLUTION || 720),
  });
}
