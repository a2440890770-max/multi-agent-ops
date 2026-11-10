import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readExtractAudioConfig } from '../extract-audio/config.js';
import { TranscriptionError, type TranscribeAudioConfig } from './types.js';

const configSchema = z.strictObject({
  whisperPath: z.string().refine((value) => value === 'whisper-cli' || isAbsolute(value)),
  modelPath: z.string().refine(isAbsolute),
  mediaRoot: z.string().refine(isAbsolute),
  timeoutMs: z.int().min(1).max(2_147_481_000),
  threads: z.int().min(1).max(256),
});
export function validateTranscribeAudioConfig(value: unknown): TranscribeAudioConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success)
    throw new TranscriptionError('CONFIGURATION_INVALID', '音频转写工具的后端配置无效。');
  return parsed.data;
}
export function readTranscribeAudioConfig(
  env: NodeJS.ProcessEnv = process.env,
): TranscribeAudioConfig {
  return validateTranscribeAudioConfig({
    whisperPath: env.TRANSCRIBE_AUDIO_WHISPER_PATH?.trim() || 'whisper-cli',
    modelPath:
      env.TRANSCRIBE_AUDIO_MODEL_PATH?.trim() ||
      join(homedir(), '.local/share/whisper.cpp/models/ggml-small.bin'),
    mediaRoot: readExtractAudioConfig(env).mediaRoot,
    timeoutMs: Number(env.TRANSCRIBE_AUDIO_TIMEOUT_MS || 600_000),
    threads: Number(env.TRANSCRIBE_AUDIO_THREADS || 4),
  });
}
