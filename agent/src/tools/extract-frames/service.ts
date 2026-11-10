import {
  ExtractFramesInputSchema,
  ExtractFramesResultSchema,
  ExtractFramesAvailableSchema,
  type ExtractFramesAvailable,
  type ExtractedFrame,
  type ExtractFramesResult,
} from '@multi-agent-ops/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { runVideoProcess, videoProcessEnv } from '../fetch-video/process.js';
import { VideoError, type VideoAsset } from '../fetch-video/types.js';
import { validateExtractFramesConfig } from './config.js';
import {
  createFrameSelector,
  createSamplingPlan,
  numeric,
  object,
  ratio,
  type Candidate,
} from './sampling.js';
import {
  FramesError,
  type FrameAsset,
  type FrameSetAsset,
  type ExtractFramesOptions,
} from './types.js';

const executionSchema = z.strictObject({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  stepId: z.string().min(1),
  inputSnapshotId: z.string().min(1),
  authorizationId: z.string().min(1),
});
const profileSchema = z.strictObject({
  mode: z.enum(['uniform', 'timestamps']),
  times: z.array(z.number().nonnegative().finite()).min(1),
  maxLongEdge: z.int().min(1).max(1920),
});
type Profile = z.infer<typeof profileSchema>;
const manifestSchema = z.strictObject({
  execution: executionSchema,
  profile: profileSchema,
  videoAssetId: z.string().min(1),
  fingerprint: z.string(),
  resultSizeBytes: z.int().positive(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fileName = (pts: number) => `frame_${pts}.png`;
async function checksum(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  signal.throwIfAborted();
  return hash.digest('hex');
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new FramesError('STORAGE_ERROR', '抽帧资源目录不能是符号链接。');
}
async function jsonFile(path: string, signal: AbortSignal, small = false): Promise<unknown> {
  signal.throwIfAborted();
  const stat = await lstat(path);
  if (!stat.isFile() || (small && stat.size > 64 * 1024)) throw new Error('Invalid metadata');
  return JSON.parse(await readFile(path, { encoding: 'utf8', signal })) as unknown;
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

/** Extract sampled images only. No OCR, vision model, source edits, network or automatic retry. */
export function createExtractFramesService(options: ExtractFramesOptions) {
  const config = validateExtractFramesConfig(options.config);
  const execution = executionSchema.parse(options.execution);
  for (const key of ['taskId', 'attemptId', 'inputSnapshotId', 'authorizationId'] as const)
    if (options.videoService.execution[key] !== execution[key])
      throw new FramesError('CONFIGURATION_INVALID', '抽帧与视频服务必须绑定同一执行及授权。');
  if (config.mediaRoot !== options.videoService.config.mediaRoot)
    throw new FramesError('CONFIGURATION_INVALID', '抽帧与视频服务必须共用资源根目录。');
  const runner = options.runProcess ?? runVideoProcess;
  const taskDirectory = join(config.mediaRoot, digest(execution.taskId));
  const fingerprint = (video: VideoAsset, profile: Profile) =>
    digest(
      JSON.stringify([
        'extract_frames-v1-nearest-png-demux-pts',
        video.result.videoAssetId,
        video.result.sha256,
        video.result.sourceId,
        video.result.durationSeconds,
        profile,
      ]),
    );
  async function authorized(videoAssetId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const video = await abortable(options.videoService.getAsset(videoAssetId, signal), signal);
    signal.throwIfAborted();
    if (!video)
      throw new FramesError('VIDEO_NOT_FOUND', '视频资源不存在、损坏或不适用于当前任务。');
    if (video.taskId !== execution.taskId || video.result.videoAssetId !== videoAssetId)
      throw new FramesError('SOURCE_NOT_AUTHORIZED', '视频不属于当前任务。');
    return video;
  }
  async function readSet(
    frameSetId: string,
    signal: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<FrameSetAsset | null> {
    signal.throwIfAborted();
    if (!/^frames_[a-f0-9-]{36}$/.test(frameSetId)) return null;
    const folder = join(taskDirectory, frameSetId);
    try {
      for (const path of [config.mediaRoot, taskDirectory, folder]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      }
      const manifest = manifestSchema.parse(
        await jsonFile(join(folder, 'manifest.json'), signal, true),
      );
      if (
        manifest.execution.taskId !== execution.taskId ||
        (expectedFingerprint && manifest.fingerprint !== expectedFingerprint)
      )
        return null;
      const video = await authorized(manifest.videoAssetId, signal);
      if (fingerprint(video, manifest.profile) !== manifest.fingerprint) return null;
      const resultPath = join(folder, 'result.json');
      const stat = await lstat(resultPath);
      if (
        !stat.isFile() ||
        stat.size !== manifest.resultSizeBytes ||
        (await checksum(resultPath, signal)) !== manifest.resultSha256
      )
        return null;
      const result = ExtractFramesAvailableSchema.parse(await jsonFile(resultPath, signal));
      if (
        result.frameSetId !== frameSetId ||
        result.videoAssetId !== video.result.videoAssetId ||
        result.sourceId !== video.result.sourceId ||
        result.videoDurationSeconds !== video.result.durationSeconds ||
        result.samplingMode !== manifest.profile.mode ||
        result.requests.length !== manifest.profile.times.length ||
        result.requests.some(
          (request, index) => request.requestedTimeSeconds !== manifest.profile.times[index],
        )
      )
        return null;
      const uuid = frameSetId.slice('frames_'.length);
      for (const frame of result.frames) {
        if (
          frame.frameAssetId !== `frame_${uuid}_${frame.sourceFrameIndex}` ||
          Math.max(frame.width, frame.height) > manifest.profile.maxLongEdge
        )
          return null;
        const path = join(folder, fileName(frame.sourcePts));
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.size !== frame.sizeBytes ||
          (await realpath(path)) !== join(await realpath(folder), fileName(frame.sourcePts)) ||
          (await checksum(path, signal)) !== frame.sha256
        )
          return null;
      }
      await authorized(manifest.videoAssetId, signal);
      return { taskId: execution.taskId, execution: manifest.execution, directory: folder, result };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof FramesError || error instanceof VideoError) throw error;
      return null;
    }
  }

  async function extract(
    value: unknown,
    call: { signal?: AbortSignal } = {},
  ): Promise<ExtractFramesResult> {
    const parsed = ExtractFramesInputSchema.safeParse(value);
    if (!parsed.success)
      return failed(
        null,
        new FramesError(
          'INVALID_INPUT',
          'extract_frames 只接受 videoAssetId 及互斥的 count 或 timestampsSeconds。',
        ),
      );
    const { videoAssetId } = parsed.data;
    const count = parsed.data.timestampsSeconds?.length ?? parsed.data.count ?? config.defaultCount;
    if (count > config.maxFrames)
      return failed(
        videoAssetId,
        new FramesError('INVALID_INPUT', '请求数量超过后端上限；未截断请求。'),
      );
    const controller = new AbortController();
    const cancel = () =>
      controller.abort(new FramesError('CANCELLED', '抽帧已取消，未交付本次图片。'));
    const timer = setTimeout(
      () => controller.abort(new FramesError('TIMEOUT', '抽帧超过配置的总时限，未交付本次图片。')),
      config.timeoutMs,
    );
    call.signal?.addEventListener('abort', cancel, { once: true });
    if (call.signal?.aborted) cancel();
    const signal = controller.signal;
    let folder: string | undefined;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let lockPath: string | undefined;
    let indexPath: string | undefined;
    let committed = false,
      retained = false;
    let result: ExtractFramesResult;
    const run = async (
      executable: string,
      args: string[],
      extra: { captureStdout?: boolean; onStdoutLine?: (line: string) => void } = {},
    ) => {
      signal.throwIfAborted();
      const output = await runner({
        executable,
        args,
        cwd: folder ?? taskDirectory,
        env: videoProcessEnv(),
        signal,
        ...extra,
      });
      signal.throwIfAborted();
      if (/no space left|disk full|disk quota exceeded/i.test(output.stderr))
        throw new FramesError('STORAGE_ERROR', '磁盘空间不足，未采用本次抽帧结果。', true);
      if (output.exitSignal)
        throw new FramesError('EXTRACTION_FAILED', '媒体进程被系统终止，未采用本次结果。', true);
      return output;
    };
    try {
      let video = await authorized(videoAssetId, signal);
      const plan = createSamplingPlan(parsed.data, video, config);
      const profile: Profile = { ...plan, maxLongEdge: config.maxLongEdge };
      const key = fingerprint(video, profile);
      await directory(config.mediaRoot);
      await directory(taskDirectory);
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
      if (fingerprint(video, profile) !== key)
        throw new FramesError('INVALID_MEDIA', '等待期间视频资源发生变化。');
      let cached: FrameSetAsset | null = null;
      try {
        const index = object(await jsonFile(indexPath, signal, true));
        if (typeof index.frameSetId === 'string')
          cached = await readSet(index.frameSetId, signal, key);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof FramesError || error instanceof VideoError) throw error;
      }
      if (cached) result = { ...cached.result, reused: true };
      else {
        if (waited)
          throw new FramesError(
            'EXTRACTION_FAILED',
            '原调用没有产生可复用的有效结果；未自动重新抽帧。',
            true,
          );
        const uuid = randomUUID();
        const frameSetId = `frames_${uuid}`;
        folder = join(taskDirectory, frameSetId);
        await directory(folder);
        const input = [
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          video.result.container === 'mp4' ? 'mov' : 'matroska',
          '-i',
          video.filePath,
        ];
        const probe = await run(config.ffprobePath, [
          '-v',
          'error',
          ...input,
          '-show_streams',
          '-of',
          'json',
        ]);
        if (probe.exitCode !== 0 || probe.stderr.trim())
          throw new FramesError('INVALID_MEDIA', '无法读取可靠的视频轨道信息。');
        let metadata: Record<string, unknown>;
        try {
          metadata = object(JSON.parse(probe.stdout));
        } catch {
          throw new FramesError('INVALID_MEDIA', '视频元数据不是有效 JSON。');
        }
        const streams = Array.isArray(metadata.streams) ? metadata.streams.map(object) : [];
        const tracks = streams.filter(
          (stream) =>
            stream.codec_type === 'video' && object(stream.disposition).attached_pic !== 1,
        );
        const track =
          tracks.find((stream) => object(stream.disposition).default === 1) ?? tracks[0];
        if (!track) throw new FramesError('NO_VIDEO', '没有可抽取的实际视频轨道。');
        const trackIndex = numeric(track.index),
          start = numeric(track.start_time),
          timeBase = ratio(track.time_base);
        if (
          trackIndex === null ||
          !Number.isSafeInteger(trackIndex) ||
          trackIndex < 0 ||
          start === null ||
          !timeBase
        )
          throw new FramesError('TIMELINE_UNAVAILABLE', '视频轨道缺少可靠的起点或时间基准。');
        const sideData = Array.isArray(track.side_data_list)
          ? track.side_data_list.map(object)
          : [];
        const rawRotation =
          numeric(sideData.find((data) => data.rotation !== undefined)?.rotation) ?? 0;
        const rotation = ((rawRotation % 360) + 360) % 360;
        if (![0, 90, 180, 270].includes(rotation))
          throw new FramesError(
            'INVALID_MEDIA',
            '首版只支持标准直角旋转信息，未擅自裁剪或改写画面方向。',
          );
        const sar = ratio(track.sample_aspect_ratio);
        const selector = createFrameSelector(plan, {
          start,
          timeBase,
          duration: video.result.durationSeconds,
          sar: sar ? sar[0] / sar[1] : 1,
        });
        const scan = await run(
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
            'frame=pts,width,height,sample_aspect_ratio',
            '-of',
            'compact=p=0:nk=0',
          ],
          { captureStdout: false, onStdoutLine: selector.observe },
        );
        if (scan.exitCode !== 0 || scan.stderr.trim())
          throw new FramesError('INVALID_MEDIA', '视频帧时间轴未通过完整解码检查。');
        const candidates = [
          ...new Map(
            selector.selected
              .filter((frame): frame is Candidate => frame !== null)
              .map((frame) => [frame.index, frame]),
          ).values(),
        ].sort((a, b) => a.index - b.index);
        if (!candidates.length)
          throw new FramesError('INVALID_MEDIA', '视频中没有可定位的有效画面帧。');
        const select = candidates.map((frame) => `eq(n\\,${frame.index})`).join('+');
        const scale = `scale=w='min(iw,${config.maxLongEdge})':h='min(ih,${config.maxLongEdge})':force_original_aspect_ratio=decrease:reset_sar=1`;
        // Preserve demuxer PTS in PNG filenames; never infer actual time from requested time or untrusted logs.
        const encode = await run(
          config.ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-n',
            '-copyts',
            '-xerror',
            '-err_detect',
            'explode',
            ...input,
            '-map',
            `0:${trackIndex}`,
            '-an',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-vf',
            `select=${select},${scale}`,
            '-fps_mode',
            'passthrough',
            '-enc_time_base',
            'demux',
            '-frames:v',
            String(candidates.length),
            '-c:v',
            'png',
            '-f',
            'image2',
            '-frame_pts',
            '1',
            join(folder, 'frame_%d.png'),
          ],
          { captureStdout: false },
        );
        const frames: ExtractedFrame[] = [];
        const byIndex = new Map<number, ExtractedFrame>();
        const errors = new Map<
          number,
          { code: 'INVALID_FRAME' | 'EXTRACTION_FAILED'; message: string }
        >();
        for (const candidate of candidates) {
          const path = join(folder, fileName(candidate.pts));
          try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.size <= 0)
              throw new FramesError('INVALID_FRAME', '图片不是有效普通文件。');
            const handle = await open(path, 'r');
            const header = Buffer.alloc(24);
            try {
              await handle.read(header, 0, 24, 0);
            } finally {
              await handle.close();
            }
            if (
              !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              header.toString('ascii', 12, 16) !== 'IHDR'
            )
              throw new FramesError('INVALID_FRAME', '图片不是有效 PNG。');
            const width = header.readUInt32BE(16),
              height = header.readUInt32BE(20);
            const displayWidth =
              rotation === 90 || rotation === 270
                ? candidate.height
                : candidate.width * candidate.sar;
            const displayHeight =
              rotation === 90 || rotation === 270
                ? candidate.width * candidate.sar
                : candidate.height;
            if (
              !width ||
              !height ||
              Math.max(width, height) > config.maxLongEdge ||
              width > Math.ceil(displayWidth) ||
              height > Math.ceil(displayHeight) ||
              Math.abs(width * displayHeight - height * displayWidth) >
                Math.max(displayWidth, displayHeight) * 1.1
            )
              throw new FramesError(
                'INVALID_FRAME',
                '图片尺寸、方向或比例不符合不放大和等比例缩放要求。',
              );
            const decoded = await run(config.ffmpegPath, [
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
              'png_pipe',
              '-i',
              path,
              '-frames:v',
              '1',
              '-f',
              'null',
              '-',
            ]);
            if (decoded.exitCode !== 0 || decoded.stderr.trim())
              throw new FramesError('INVALID_FRAME', 'PNG 未通过完整解码校验。');
            await chmod(path, 0o600);
            const frame: ExtractedFrame = {
              frameAssetId: `frame_${uuid}_${candidate.index}`,
              sourceFrameIndex: candidate.index,
              sourcePts: candidate.pts,
              actualTimeSeconds: candidate.time,
              format: 'png',
              width,
              height,
              sizeBytes: stat.size,
              sha256: await checksum(path, signal),
            };
            frames.push(frame);
            byIndex.set(candidate.index, frame);
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (
              error instanceof VideoError ||
              (error instanceof FramesError && error.code !== 'INVALID_FRAME')
            )
              throw error;
            errors.set(candidate.index, {
              code: object(error).code === 'ENOENT' ? 'EXTRACTION_FAILED' : 'INVALID_FRAME',
              message: '该采样帧未生成或未通过图片校验；没有用其他时间点替代。',
            });
            await rm(path, { force: true });
          }
        }
        if (!frames.length)
          throw new FramesError('EXTRACTION_FAILED', '没有采样帧通过校验，未交付本次结果。');
        const retainedNames = new Set(frames.map((frame) => fileName(frame.sourcePts)));
        for (const name of await readdir(folder))
          if (name.endsWith('.png') && !retainedNames.has(name))
            await rm(join(folder, name), { force: true });
        const requests: ExtractFramesAvailable['requests'] = selector.selected.map(
          (candidate, index) => {
            const common = { requestIndex: index, requestedTimeSeconds: plan.times[index]! };
            const frame = candidate ? byIndex.get(candidate.index) : undefined;
            if (frame) return { ...common, status: 'succeeded', frameAssetId: frame.frameAssetId };
            return {
              ...common,
              status: 'failed',
              ...((candidate ? errors.get(candidate.index) : undefined) ?? {
                code: 'EXTRACTION_FAILED' as const,
                message: '该时间点没有可定位的画面。',
              }),
            };
          },
        );
        const failureCount = requests.filter((request) => request.status === 'failed').length;
        const warnings: ExtractFramesAvailable['warnings'] = [
          {
            code: 'SAMPLED_FRAMES_ONLY',
            message:
              '仅取得所列时间点的抽样画面；未进行 OCR 或视觉理解，不能声称完整观看或实际测试项目。',
          },
        ];
        if (requests.length - failureCount > frames.length)
          warnings.push({
            code: 'DUPLICATE_FRAME_MATCHES',
            message: '多个请求命中同一实际帧，已去重并保留请求到图片的映射；未补造图片。',
          });
        if (failureCount)
          warnings.push({
            code: 'PARTIAL_EXTRACTION',
            message: '仅保留通过校验的画面，失败采样点已逐项标记。',
          });
        if (encode.exitCode !== 0 || encode.stderr.trim())
          warnings.push({
            code: 'ENCODER_REPORTED_ERROR',
            message: '编码过程报告错误；只交付通过独立图片校验的实际采样帧。',
          });
        result = ExtractFramesAvailableSchema.parse({
          schemaVersion: '1.0',
          status: failureCount ? 'partial' : 'succeeded',
          frameSetId,
          videoAssetId,
          sourceId: video.result.sourceId,
          samplingMode: plan.mode,
          requestedCount: plan.times.length,
          selectedVideoStreamIndex: trackIndex,
          videoDurationSeconds: video.result.durationSeconds,
          videoStartTimeSeconds: start,
          timeBaseNumerator: timeBase[0],
          timeBaseDenominator: timeBase[1],
          inputScope: 'sampled_frames',
          analysisPerformed: false,
          frames,
          requests,
          warnings,
          extractedAt: new Date().toISOString(),
          reused: false,
        });
        const current = await authorized(videoAssetId, signal);
        if (fingerprint(current, profile) !== key)
          throw new FramesError('INVALID_MEDIA', '处理期间视频资源发生变化。');
        const resultPath = join(folder, 'result.json');
        await writeFile(resultPath, JSON.stringify(result), { mode: 0o600, flag: 'wx', signal });
        const stat = await lstat(resultPath);
        await writeFile(
          join(folder, 'manifest.json'),
          JSON.stringify({
            execution,
            profile,
            videoAssetId,
            fingerprint: key,
            resultSizeBytes: stat.size,
            resultSha256: await checksum(resultPath, signal),
          }),
          { mode: 0o600, flag: 'wx', signal },
        );
        const temporaryIndex = join(folder, 'index.private.json');
        await writeFile(temporaryIndex, JSON.stringify({ frameSetId }), {
          mode: 0o600,
          flag: 'wx',
          signal,
        });
        await rename(temporaryIndex, indexPath);
        committed = true;
        signal.throwIfAborted();
        retained = true;
      }
      signal.throwIfAborted();
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
        new FramesError('STORAGE_ERROR', '抽帧残留清理失败，需要后端检查资源目录。'),
      );
    } finally {
      if (lock) {
        try {
          await lock.close();
          await rm(lockPath!, { force: true });
        } catch {
          result = failed(
            videoAssetId,
            new FramesError('STORAGE_ERROR', '抽帧资源解锁失败，需要后端检查资源目录。'),
          );
        }
      }
    }
    return ExtractFramesResultSchema.parse(result);
  }

  async function getFrameAsset(
    frameAssetId: string,
    signal: AbortSignal,
  ): Promise<FrameAsset | null> {
    const match = /^frame_([a-f0-9-]{36})_([0-9]+)$/.exec(frameAssetId);
    if (!match) return null;
    const set = await readSet(`frames_${match[1]}`, signal);
    const frame = set?.result.frames.find((entry) => entry.frameAssetId === frameAssetId);
    if (!set || !frame) return null;
    return {
      taskId: execution.taskId,
      execution: set.execution,
      filePath: join(set.directory, fileName(frame.sourcePts)),
      frameSetId: set.result.frameSetId,
      videoAssetId: set.result.videoAssetId,
      sourceId: set.result.sourceId,
      result: frame,
    };
  }
  return {
    extract,
    execution: { ...execution },
    config: { ...config },
    getAsset: (id: string, signal: AbortSignal) => readSet(id, signal),
    getFrameAsset,
  };
}
function failed(videoAssetId: string | null, error: unknown): ExtractFramesResult {
  const normalized =
    error instanceof FramesError
      ? error
      : error instanceof VideoError
        ? new FramesError(
            error.code === 'SOURCE_NOT_AUTHORIZED'
              ? 'SOURCE_NOT_AUTHORIZED'
              : error.code === 'DEPENDENCY_UNAVAILABLE'
                ? 'DEPENDENCY_UNAVAILABLE'
                : 'INVALID_MEDIA',
            '视频授权、完整性或媒体依赖检查失败。',
          )
        : new FramesError('STORAGE_ERROR', '抽帧未完成，内部路径和原始错误已省略。');
  return {
    schemaVersion: '1.0',
    status: 'failed',
    videoAssetId,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
}
