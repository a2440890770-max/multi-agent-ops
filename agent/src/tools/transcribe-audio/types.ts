import type { TranscribeAudioErrorCode, TranscribeAudioSucceeded } from '@multi-agent-ops/shared';
import type { createExtractAudioService } from '../extract-audio/service.js';
import type { VideoExecution, VideoProcessRunner } from '../fetch-video/types.js';

export interface TranscribeAudioConfig {
  whisperPath: string;
  modelPath: string;
  mediaRoot: string;
  timeoutMs: number;
  threads: number;
}
export interface TranscribeAudioOptions {
  execution: VideoExecution;
  config: TranscribeAudioConfig;
  audioService: Pick<
    ReturnType<typeof createExtractAudioService>,
    'getAsset' | 'execution' | 'config'
  >;
  runProcess?: VideoProcessRunner;
}
export interface TranscriptAsset {
  taskId: string;
  execution: VideoExecution;
  filePath: string;
  result: TranscribeAudioSucceeded;
}
export class TranscriptionError extends Error {
  constructor(
    readonly code: TranscribeAudioErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}
