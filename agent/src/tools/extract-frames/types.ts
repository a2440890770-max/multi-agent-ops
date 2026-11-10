import type {
  ExtractedFrame,
  ExtractFramesAvailable,
  ExtractFramesErrorCode,
} from '@multi-agent-ops/shared';
import type { createFetchVideoService } from '../fetch-video/service.js';
import type { VideoExecution, VideoProcessRunner } from '../fetch-video/types.js';

export interface ExtractFramesConfig {
  ffmpegPath: string;
  ffprobePath: string;
  mediaRoot: string;
  timeoutMs: number;
  defaultCount: number;
  maxFrames: number;
  maxLongEdge: number;
}
export interface ExtractFramesOptions {
  execution: VideoExecution;
  config: ExtractFramesConfig;
  videoService: Pick<
    ReturnType<typeof createFetchVideoService>,
    'getAsset' | 'execution' | 'config'
  >;
  runProcess?: VideoProcessRunner;
}
export interface FrameSetAsset {
  taskId: string;
  execution: VideoExecution;
  directory: string;
  result: ExtractFramesAvailable;
}
export interface FrameAsset {
  taskId: string;
  execution: VideoExecution;
  filePath: string;
  frameSetId: string;
  videoAssetId: string;
  sourceId: string;
  result: ExtractedFrame;
}
export class FramesError extends Error {
  constructor(
    readonly code: ExtractFramesErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FramesError';
  }
}
