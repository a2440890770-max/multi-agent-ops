import {
  ExtractAudioInputSchema,
  ExtractAudioResultSchema,
  ExtractAudioSucceededSchema,
  type ExtractAudioResult,
} from '@multi-agent-ops/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { runVideoProcess, videoProcessEnv } from '../fetch-video/process.js';
import { VideoError, type VideoAsset, type VideoProcessRequest } from '../fetch-video/types.js';
import { validateExtractAudioConfig } from './config.js';
import { AudioError, type AudioAsset, type ExtractAudioOptions } from './types.js';

const executionSchema = z.strictObject({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  stepId: z.string().min(1),
  inputSnapshotId: z.string().min(1),
  authorizationId: z.string().min(1),
});
const manifestSchema = z.strictObject({
  execution: executionSchema,
  fingerprint: z.string(),
  result: ExtractAudioSucceededSchema,
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function numeric(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function parseProbe(stdout: string) {
  try {
    const parsed = object(JSON.parse(stdout));
    return {
      streams: Array.isArray(parsed.streams) ? parsed.streams.map(object) : [],
      format: object(parsed.format),
    };
  } catch {
    throw new AudioError('INVALID_MEDIA', '媒体依赖没有返回有效的结构化信息。');
  }
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AudioError('STORAGE_ERROR', '媒体目录不能是符号链接。');
}
async function checksum(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  signal.throwIfAborted();
  return hash.digest('hex');
}
async function readJson(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid metadata');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Full selected track only. No network, shell, enhancement, transcription or automatic retry. */
export function createExtractAudioService(options: ExtractAudioOptions) {
  const config = validateExtractAudioConfig(options.config);
  const execution = executionSchema.parse(options.execution);
  for (const field of ['taskId', 'attemptId', 'inputSnapshotId', 'authorizationId'] as const)
    if (options.videoService.execution[field] !== execution[field])
      throw new AudioError('CONFIGURATION_INVALID', '音频与视频服务必须绑定同一执行及授权。');
  if (options.videoService.config.mediaRoot !== config.mediaRoot)
    throw new AudioError('CONFIGURATION_INVALID', '音频与视频服务必须使用同一媒体资源目录。');
  const runner = options.runProcess ?? runVideoProcess;
  const taskDirectory = join(config.mediaRoot, digest(execution.taskId));
  const fingerprint = (video: VideoAsset) =>
    digest(
      JSON.stringify([
        'extract_audio-v1-full-default-pcm16-16k-mono-rf64',
        video.result.videoAssetId,
        video.result.sha256,
      ]),
    );

  async function authorized(videoAssetId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const video = await abortable(options.videoService.getAsset(videoAssetId, signal), signal);
    signal.throwIfAborted();
    if (!video)
      throw new AudioError('VIDEO_NOT_FOUND', '视频资源不存在、已损坏或不再适用于当前任务。');
    if (video.taskId !== execution.taskId || video.result.videoAssetId !== videoAssetId)
      throw new AudioError('SOURCE_NOT_AUTHORIZED', '视频资源不属于当前任务。');
    return video;
  }

  async function readAsset(audioAssetId: string, signal: AbortSignal): Promise<AudioAsset | null> {
    signal.throwIfAborted();
    if (!/^audio_[a-f0-9-]{36}$/.test(audioAssetId)) return null;
    const folder = join(taskDirectory, audioAssetId);
    try {
      for (const path of [config.mediaRoot, taskDirectory, folder]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      }
      const manifest = manifestSchema.parse(await readJson(join(folder, 'manifest.json')));
      if (
        manifest.execution.taskId !== execution.taskId ||
        manifest.result.audioAssetId !== audioAssetId
      )
        return null;
      const video = await authorized(manifest.result.videoAssetId, signal);
      if (
        manifest.fingerprint !== fingerprint(video) ||
        manifest.result.sourceId !== video.result.sourceId
      )
        return null;
      const filePath = join(folder, 'audio.wav');
      const stat = await lstat(filePath);
      if (
        !stat.isFile() ||
        stat.size !== manifest.result.sizeBytes ||
        (await realpath(filePath)) !== join(await realpath(folder), 'audio.wav') ||
        (await checksum(filePath, signal)) !== manifest.result.sha256
      )
        return null;
      await authorized(manifest.result.videoAssetId, signal);
      return {
        taskId: execution.taskId,
        execution: manifest.execution,
        filePath,
        result: manifest.result,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AudioError || error instanceof VideoError) throw error;
      return null;
    }
  }

  async function extract(
    value: unknown,
    call: { signal?: AbortSignal } = {},
  ): Promise<ExtractAudioResult> {
    const parsed = ExtractAudioInputSchema.safeParse(value);
    if (!parsed.success)
      return failed(
        null,
        new AudioError('INVALID_INPUT', 'extract_audio 只接受已登记的 videoAssetId。'),
      );
    const { videoAssetId } = parsed.data;
    const controller = new AbortController();
    const cancel = () => controller.abort(new AudioError('CANCELLED', '音频提取已取消。'));
    const timer = setTimeout(
      () => controller.abort(new AudioError('TIMEOUT', '音频提取超过配置的总时限。')),
      config.timeoutMs,
    );
    call.signal?.addEventListener('abort', cancel, { once: true });
    if (call.signal?.aborted) cancel();
    const signal = controller.signal;
    let folder: string | undefined;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let lockPath: string | undefined;
    let indexPath: string | undefined;
    let committed = false;
    let retained = false;
    let result: ExtractAudioResult;
    const processEnv = videoProcessEnv();
    async function process(
      executable: string,
      args: string[],
      extra: Partial<Pick<VideoProcessRequest, 'onStdoutLine' | 'captureStdout'>> = {},
    ) {
      signal.throwIfAborted();
      const output = await runner({
        executable,
        args,
        cwd: folder ?? taskDirectory,
        env: processEnv,
        signal,
        ...extra,
      });
      signal.throwIfAborted();
      if (/no space left|disk full|disk quota exceeded/i.test(output.stderr))
        throw new AudioError(
          'STORAGE_ERROR',
          '本地磁盘空间不足，音频未被采用；释放空间后可手动重试。',
          true,
        );
      if (output.exitCode !== 0 || output.stderr.trim())
        throw new AudioError(
          'EXTRACTION_FAILED',
          '媒体解码或音频处理失败；未采用部分结果，内部输出已省略。',
        );
      return output;
    }
    try {
      let video = await authorized(videoAssetId, signal);
      await directory(config.mediaRoot);
      await directory(taskDirectory);
      const key = fingerprint(video);
      indexPath = join(taskDirectory, `${key}.json`);
      lockPath = join(taskDirectory, `${key}.lock`);
      let waited = false;
      while (!lock) {
        signal.throwIfAborted();
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (object(error).code !== 'EEXIST') throw error;
          waited = true;
          await delay(25, undefined, { signal });
        }
      }
      video = await authorized(videoAssetId, signal);
      if (fingerprint(video) !== key)
        throw new AudioError('INVALID_MEDIA', '等待期间视频资源已发生变化。');
      let cached: AudioAsset | null = null;
      try {
        const index = object(await readJson(indexPath));
        if (typeof index.audioAssetId === 'string')
          cached = await readAsset(index.audioAssetId, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof AudioError || error instanceof VideoError) throw error;
      }
      if (cached && cached.result.videoAssetId === videoAssetId) {
        result = { ...cached.result, reused: true };
      } else {
        if (waited)
          throw new AudioError(
            'EXTRACTION_FAILED',
            '并发的原提取未产生可复用结果；未自动重新提取。',
            true,
          );
        const audioAssetId = `audio_${randomUUID()}`;
        folder = join(taskDirectory, audioAssetId);
        await directory(folder);
        const inputFormat = video.result.container === 'mp4' ? 'mov' : 'matroska';
        const input = ['-protocol_whitelist', 'file,pipe', '-f', inputFormat, '-i', video.filePath];
        const metadata = parseProbe(
          (
            await process(config.ffprobePath, [
              '-v',
              'error',
              ...input,
              '-show_streams',
              '-show_format',
              '-of',
              'json',
            ])
          ).stdout,
        );
        const tracks = metadata.streams.filter((stream) => stream.codec_type === 'audio');
        const track =
          tracks.find((stream) => object(stream.disposition).default === 1) ?? tracks[0];
        if (!track) throw new AudioError('NO_AUDIO', '视频没有可提取的音轨。');
        const trackIndex = numeric(track.index);
        const sampleRate = numeric(track.sample_rate);
        const videoTrack = metadata.streams.find((stream) => stream.codec_type === 'video');
        const videoStart = numeric(videoTrack?.start_time);
        if (
          trackIndex === null ||
          !Number.isInteger(trackIndex) ||
          trackIndex < 0 ||
          !sampleRate ||
          sampleRate <= 0 ||
          videoStart === null
        )
          throw new AudioError(
            'TIMELINE_UNAVAILABLE',
            '音轨或视频起点信息不足，无法可靠定位原视频时间。',
          );
        let firstTime: number | null = null;
        let expectedTime: number | null = null;
        let samples = 0;
        // Decode frame metadata as a stream: memory is independent of video duration.
        await process(
          config.ffprobePath,
          [
            '-v',
            'error',
            '-err_detect',
            'explode',
            ...input,
            '-select_streams',
            String(trackIndex),
            '-show_frames',
            '-show_entries',
            'frame=pts_time,nb_samples',
            '-of',
            'compact=p=0:nk=0',
          ],
          {
            captureStdout: false,
            onStdoutLine(line) {
              if (!line.trim()) return;
              const fields = Object.fromEntries(
                line
                  .trim()
                  .split('|')
                  .map((field) => field.split('=')),
              );
              const time = numeric(fields.pts_time);
              const count = numeric(fields.nb_samples);
              if (
                time === null ||
                count === null ||
                !Number.isInteger(count) ||
                count <= 0 ||
                (expectedTime !== null && Math.abs(time - expectedTime) > 0.002) ||
                (firstTime !== null && Math.abs(time - (firstTime + samples / sampleRate)) > 0.002)
              )
                throw new AudioError(
                  'TIMELINE_UNAVAILABLE',
                  '音频时间戳缺失或不连续，不能可靠映射原视频。',
                );
              firstTime ??= time;
              expectedTime = time + count / sampleRate;
              samples += count;
            },
          },
        );
        if (firstTime === null || samples <= 0)
          throw new AudioError('INVALID_MEDIA', '选定音轨没有完整可解码的音频。');
        const sourceDuration = samples / sampleRate;
        const declaredDuration = numeric(track.duration);
        if (declaredDuration !== null && Math.abs(sourceDuration - declaredDuration) > 0.1)
          throw new AudioError(
            'INVALID_MEDIA',
            '解码音频与声明时长不一致，未接受可能不完整的结果。',
          );
        const filePath = join(folder, 'audio.wav');
        await process(config.ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-n',
          '-xerror',
          '-err_detect',
          'explode',
          ...input,
          '-map',
          `0:${trackIndex}`,
          '-vn',
          '-sn',
          '-dn',
          '-map_metadata',
          '-1',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-rf64',
          'auto',
          filePath,
        ]);
        const audio = parseProbe(
          (
            await process(config.ffprobePath, [
              '-v',
              'error',
              '-protocol_whitelist',
              'file,pipe',
              '-f',
              'wav',
              '-i',
              filePath,
              '-show_streams',
              '-show_format',
              '-of',
              'json',
            ])
          ).stdout,
        );
        const stream = audio.streams[0];
        const duration = numeric(audio.format.duration);
        if (
          audio.streams.length !== 1 ||
          stream?.codec_name !== 'pcm_s16le' ||
          numeric(stream.sample_rate) !== 16000 ||
          stream.channels !== 1 ||
          stream.bits_per_sample !== 16 ||
          !duration ||
          duration <= 0 ||
          Math.abs(duration - sourceDuration) > 0.002
        )
          throw new AudioError('INVALID_AUDIO', '输出音频的格式、采样参数或完整时长不符合契约。');
        await process(config.ffmpegPath, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-xerror',
          '-err_detect',
          'explode',
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          'wav',
          '-i',
          filePath,
          '-map',
          '0:a:0',
          '-f',
          'null',
          '-',
        ]);
        const stat = await lstat(filePath);
        if (!stat.isFile() || stat.size <= 0)
          throw new AudioError('INVALID_AUDIO', '输出不是有效音频文件。');
        result = ExtractAudioSucceededSchema.parse({
          schemaVersion: '1.0',
          status: 'succeeded',
          audioAssetId,
          videoAssetId,
          sourceId: video.result.sourceId,
          selectedAudioStreamIndex: trackIndex,
          format: 'wav',
          codec: 'pcm_s16le',
          sampleRateHz: 16000,
          channels: 1,
          durationSeconds: duration,
          sizeBytes: stat.size,
          sourceTimeOffsetSeconds: firstTime - videoStart,
          sha256: await checksum(filePath, signal),
          extractedAt: new Date().toISOString(),
          reused: false,
        });
        const current = await authorized(videoAssetId, signal);
        if (fingerprint(current) !== key)
          throw new AudioError('INVALID_MEDIA', '处理期间视频资源已发生变化。');
        signal.throwIfAborted();
        await writeFile(
          join(folder, 'manifest.json'),
          JSON.stringify({ execution, fingerprint: key, result }),
          { mode: 0o600, flag: 'wx' },
        );
        const temporaryIndex = join(folder, 'index.private.json');
        await writeFile(temporaryIndex, JSON.stringify({ audioAssetId }), {
          mode: 0o600,
          flag: 'wx',
        });
        await rename(temporaryIndex, indexPath);
        committed = true;
        signal.throwIfAborted();
        retained = true;
      }
    } catch (error) {
      result = failed(videoAssetId, signal.aborted ? signal.reason : error);
    }
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', cancel);
    try {
      if (!retained && folder) {
        await rm(folder, { recursive: true, force: true });
        if (committed && indexPath) await rm(indexPath, { force: true });
      }
    } catch {
      result = failed(
        videoAssetId,
        new AudioError('STORAGE_ERROR', '音频残留清理失败，需要后端检查任务资源目录。'),
      );
    } finally {
      if (lock) {
        try {
          await lock.close();
          await rm(lockPath!, { force: true });
        } catch {
          result = failed(
            videoAssetId,
            new AudioError('STORAGE_ERROR', '音频资源解锁失败，需要后端检查任务资源目录。'),
          );
        }
      }
    }
    return ExtractAudioResultSchema.parse(result);
  }

  return { extract, getAsset: readAsset, execution: { ...execution }, config: { ...config } };
}

function failed(videoAssetId: string | null, error: unknown): ExtractAudioResult {
  const normalized =
    error instanceof AudioError
      ? error
      : error instanceof VideoError
        ? new AudioError(
            error.code === 'SOURCE_NOT_AUTHORIZED'
              ? 'SOURCE_NOT_AUTHORIZED'
              : error.code === 'DEPENDENCY_UNAVAILABLE'
                ? 'DEPENDENCY_UNAVAILABLE'
                : 'INVALID_MEDIA',
            '视频资源验证或本地处理依赖失败。',
          )
        : new AudioError('STORAGE_ERROR', '音频提取未完成；内部路径和原始错误已省略。');
  return {
    schemaVersion: '1.0',
    status: 'failed',
    videoAssetId,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
}
