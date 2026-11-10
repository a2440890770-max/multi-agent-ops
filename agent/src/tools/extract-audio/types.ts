import type { ExtractAudioErrorCode, ExtractAudioSucceeded } from '@multi-agent-ops/shared';
import type { createFetchVideoService } from '../fetch-video/service.js';
import type { VideoExecution, VideoProcessRunner } from '../fetch-video/types.js';

export interface ExtractAudioConfig {
  ffmpegPath: string;
  ffprobePath: string;
  mediaRoot: string;
  timeoutMs: number;
}

export interface ExtractAudioOptions {
  execution: VideoExecution;
  config: ExtractAudioConfig;
  /** Use the trusted fetch_video registry, including live authorization and checksum checks. */
  videoService: Pick<
    ReturnType<typeof createFetchVideoService>,
    'getAsset' | 'execution' | 'config'
  >;
  runProcess?: VideoProcessRunner;
}

export interface AudioAsset {
  taskId: string;
  execution: VideoExecution;
  filePath: string;
  result: ExtractAudioSucceeded;
}

export class AudioError extends Error {
  constructor(
    readonly code: ExtractAudioErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AudioError';
  }
}
