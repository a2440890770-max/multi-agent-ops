import type { FetchVideoErrorCode, FetchVideoResult } from '@multi-agent-ops/shared';

export type VideoPlatform = 'bilibili' | 'xiaohongshu';
export interface VideoExecution {
  taskId: string;
  attemptId: string;
  stepId: string;
  inputSnapshotId: string;
  authorizationId: string;
}

/** A trusted registry entry, never an object supplied by the model. */
export interface RegisteredVideoSource {
  sourceId: string;
  taskId: string;
  authorizationId: string;
  url: string;
}

export interface FetchVideoConfig {
  ytDlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  mediaRoot: string;
  chromeProfile: string;
  timeoutMs: number;
  maxResolution: number;
}

export interface VideoProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Host-only streaming metadata observer; avoids buffering long-media frame listings. */
  onStdoutLine?: (line: string) => void;
  captureStdout?: boolean;
}
export interface VideoProcessResult {
  exitCode: number;
  exitSignal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
}
export type VideoProcessRunner = (request: VideoProcessRequest) => Promise<VideoProcessResult>;

export interface FetchVideoOptions {
  execution: VideoExecution;
  config: FetchVideoConfig;
  resolveSource(sourceId: string, signal: AbortSignal): Promise<RegisteredVideoSource | null>;
  /** Check live task/authorization state, including before reuse and before accepting a result. */
  authorize(request: {
    execution: VideoExecution;
    source: RegisteredVideoSource;
    signal: AbortSignal;
  }): Promise<boolean>;
  runProcess?: VideoProcessRunner;
}

export interface VideoAsset {
  taskId: string;
  execution: VideoExecution;
  filePath: string;
  result: Extract<FetchVideoResult, { status: 'succeeded' }>;
}

export class VideoError extends Error {
  constructor(
    readonly code: FetchVideoErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'VideoError';
  }
}
