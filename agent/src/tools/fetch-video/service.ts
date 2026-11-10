import {
  FetchVideoInputSchema,
  FetchVideoResultSchema,
  type FetchVideoResult,
} from '@multi-agent-ops/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
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
import { extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { validateFetchVideoConfig } from './config.js';
import { assertMediaUrl, openVideoNetworkGuard, videoPlatform } from './network.js';
import { runVideoProcess, videoProcessEnv } from './process.js';
import {
  VideoError,
  type FetchVideoOptions,
  type RegisteredVideoSource,
  type VideoAsset,
  type VideoPlatform,
} from './types.js';

type Success = Extract<FetchVideoResult, { status: 'succeeded' }>;
const executionSchema = z.strictObject({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  stepId: z.string().min(1),
  inputSnapshotId: z.string().min(1),
  authorizationId: z.string().min(1),
});
const sourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  taskId: z.string().min(1),
  authorizationId: z.string().min(1),
  url: z.string().min(1),
});
const manifestSchema = z.strictObject({
  taskId: z.string(),
  sourceFingerprint: z.string(),
  fileName: z.enum(['video.mp4', 'video.mkv', 'video.webm']),
  execution: executionSchema,
  result: FetchVideoResultSchema,
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const assetIdPattern = /^video_[a-f0-9-]{36}$/;
const json = (value: string, code: 'DOWNLOAD_FAILED' | 'INVALID_MEDIA') => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new VideoError(code, '运行依赖未返回有效的结构化媒体信息。');
  }
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function classifyFailure(stderr: string): VideoError {
  if (/cookies database|failed to decrypt|keychain|unable to extract cookies/i.test(stderr))
    return new VideoError(
      'AUTH_REQUIRED',
      '无法读取配置的 Chrome 会话，请检查浏览器用户配置及本机钥匙串访问。',
    );
  if (/403|401|fresh cookies|login required|sign in|登录|认证/i.test(stderr))
    return new VideoError(
      'AUTH_REQUIRED',
      '平台未接受当前会话，请在配置的 Chrome 中登录或完成验证后手动重试。',
    );
  if (/404|not available|not found|private video|no video formats/i.test(stderr))
    return new VideoError('SOURCE_UNAVAILABLE', '该来源未提供当前可读取的视频格式。');
  if (
    /timed out|connection reset|connection refused|temporary failure|name resolution|unable to download/i.test(
      stderr,
    )
  )
    return new VideoError(
      'NETWORK_ERROR',
      '视频网络请求失败，可由执行器按配置决定是否技术重试。',
      true,
    );
  return new VideoError('DOWNLOAD_FAILED', '视频下载失败；原始输出包含来源或会话信息，已省略。');
}

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new VideoError('STORAGE_ERROR', '媒体目录不能是符号链接。');
}

async function checksum(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  signal.throwIfAborted();
  return hash.digest('hex');
}

/** Backend-created service, bound to one task and one research authorization. */
export function createFetchVideoService(options: FetchVideoOptions) {
  const config = validateFetchVideoConfig(options.config);
  const execution = executionSchema.parse(options.execution);
  const runner = options.runProcess ?? runVideoProcess;
  const taskDirectory = join(config.mediaRoot, digest(execution.taskId));
  const fingerprint = (source: RegisteredVideoSource) =>
    digest(JSON.stringify([source.sourceId, source.url, config.maxResolution]));

  async function authorized(sourceId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const value = await abortable(options.resolveSource(sourceId, signal), signal);
    if (!value) throw new VideoError('SOURCE_NOT_FOUND', '当前任务中没有该来源记录。');
    const parsed = sourceSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.sourceId !== sourceId ||
      parsed.data.taskId !== execution.taskId ||
      parsed.data.authorizationId !== execution.authorizationId
    )
      throw new VideoError('SOURCE_NOT_AUTHORIZED', '来源不属于当前任务或本轮研究授权。');
    const source = parsed.data;
    if (!(await abortable(options.authorize({ execution, source, signal }), signal)))
      throw new VideoError(
        'SOURCE_NOT_AUTHORIZED',
        '当前任务或研究授权已失效，不能下载或复用视频。',
      );
    signal.throwIfAborted();
    return source;
  }

  async function readAsset(assetId: string, signal: AbortSignal): Promise<VideoAsset | null> {
    if (!assetIdPattern.test(assetId)) return null;
    const folder = join(taskDirectory, assetId);
    try {
      for (const path of [config.mediaRoot, taskDirectory]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      }
      if ((await lstat(folder)).isSymbolicLink()) return null;
      const manifestPath = join(folder, 'manifest.json');
      const stat = await lstat(manifestPath);
      if (!stat.isFile() || stat.size > 64 * 1024) return null;
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const result = manifest.result;
      if (
        manifest.taskId !== execution.taskId ||
        result.status !== 'succeeded' ||
        result.videoAssetId !== assetId
      )
        return null;
      const source = await authorized(result.sourceId, signal);
      if (manifest.sourceFingerprint !== fingerprint(source)) return null;
      const filePath = join(folder, manifest.fileName);
      const file = await lstat(filePath);
      if (
        !file.isFile() ||
        file.size !== result.sizeBytes ||
        (await realpath(filePath)) !== join(await realpath(folder), manifest.fileName)
      )
        return null;
      if ((await checksum(filePath, signal)) !== result.sha256) return null;
      await authorized(result.sourceId, signal);
      return { taskId: execution.taskId, execution: manifest.execution, filePath, result };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof VideoError) throw error;
      return null;
    }
  }

  async function fetch(
    value: unknown,
    call: { signal?: AbortSignal } = {},
  ): Promise<FetchVideoResult> {
    const input = FetchVideoInputSchema.safeParse(value);
    if (!input.success)
      return failure(
        null,
        new VideoError('INVALID_INPUT', 'fetch_video 只接受已登记的 sourceId。'),
      );
    const controller = new AbortController();
    const cancel = () => controller.abort(new VideoError('CANCELLED', '视频获取已取消。'));
    const timer = setTimeout(
      () => controller.abort(new VideoError('TIMEOUT', '视频获取超过配置的总时限。')),
      config.timeoutMs,
    );
    call.signal?.addEventListener('abort', cancel, { once: true });
    if (call.signal?.aborted) cancel();
    const signal = controller.signal;
    let ownedDirectory: string | undefined;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let lockPath: string | undefined;
    let indexPath: string | undefined;
    let indexCommitted = false;
    let retained = false;
    let guard: Awaited<ReturnType<typeof openVideoNetworkGuard>> | undefined;
    const execute = async (): Promise<FetchVideoResult> => {
      try {
        const source = await authorized(input.data.sourceId, signal);
        const platform = videoPlatform(source.url);
        await directory(config.mediaRoot);
        await directory(taskDirectory);
        const key = fingerprint(source);
        indexPath = join(taskDirectory, `${key}.json`);
        lockPath = join(taskDirectory, `${key}.lock`);
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (object(error).code === 'EEXIST')
            throw new VideoError(
              'RESOURCE_BUSY',
              '当前任务正在获取同一视频，请等待原调用完成。',
              true,
            );
          throw error;
        }
        try {
          const indexStat = await lstat(indexPath);
          if (indexStat.isFile() && indexStat.size < 1024) {
            const index = object(JSON.parse(await readFile(indexPath, 'utf8')));
            if (typeof index.videoAssetId === 'string') {
              const cached = await readAsset(index.videoAssetId, signal);
              if (cached) return { ...cached.result, reused: true };
            }
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof VideoError) throw error;
          // A missing or damaged index is not evidence that a file may be reused.
        }
        signal.throwIfAborted();
        const videoAssetId = `video_${randomUUID()}`;
        ownedDirectory = join(taskDirectory, videoAssetId);
        await directory(ownedDirectory);
        const privateTemp = join(ownedDirectory, 'private-temp');
        await directory(privateTemp);
        guard = await openVideoNetworkGuard(platform, signal);
        const base = [
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-cache-dir',
          '--no-playlist',
          '--no-progress',
          '--no-warnings',
          '--socket-timeout',
          '15',
          '--retries',
          '0',
          '--extractor-retries',
          '0',
          '--fragment-retries',
          '0',
          '--file-access-retries',
          '0',
          '--force-ipv4',
          '--proxy',
          guard.proxyUrl,
          ...(platform === 'xiaohongshu'
            ? ['--cookies-from-browser', `chrome:${config.chromeProfile}`]
            : []),
        ];
        const run = (executable: string, args: string[]) =>
          runner({
            executable,
            args,
            cwd: ownedDirectory!,
            env: { ...videoProcessEnv(), TMPDIR: privateTemp, TMP: privateTemp, TEMP: privateTemp },
            signal,
          });
        const metadata = await run(config.ytDlpPath, [
          ...base,
          '--skip-download',
          '--dump-single-json',
          source.url,
        ]);
        signal.throwIfAborted();
        if (guard.denied)
          throw new VideoError('NETWORK_SCOPE_DENIED', '视频请求或跳转超出平台访问范围。');
        if (metadata.exitCode !== 0) throw classifyFailure(metadata.stderr);
        const info = object(json(metadata.stdout, 'DOWNLOAD_FAILED'));
        if (
          info._type === 'playlist' ||
          info._type === 'multi_video' ||
          info.is_live === true ||
          !Array.isArray(info.formats)
        )
          throw new VideoError(
            'SOURCE_UNAVAILABLE',
            '只支持单条已录制视频，不支持直播或播放列表。',
          );
        const formats = info.formats
          .map(object)
          .filter((format) => {
            if (typeof format.url !== 'string') return false;
            if (
              !['mp4', 'm4a', 'webm'].includes(String(format.ext)) ||
              !/^[a-zA-Z0-9._-]{1,128}$/.test(String(format.format_id))
            )
              return false;
            if (format.protocol && format.protocol !== 'https') return false;
            if (
              format.vcodec !== 'none' &&
              (typeof format.width !== 'number' ||
                typeof format.height !== 'number' ||
                Math.min(format.width, format.height) <= 0 ||
                Math.min(format.width, format.height) > config.maxResolution)
            )
              return false;
            try {
              assertMediaUrl(format.url, platform);
              return true;
            } catch {
              return false;
            }
          })
          .map((format) => safeFormat(format, platform));
        if (!formats.length)
          throw new VideoError('NETWORK_SCOPE_DENIED', '没有处于允许范围的 HTTPS 视频格式。');
        // A whitelisted metadata projection prevents paths/postprocessors in raw metadata from being replayed.
        const metadataPath = join(ownedDirectory, 'metadata.private.json');
        await writeFile(
          metadataPath,
          JSON.stringify({
            id: typeof info.id === 'string' ? info.id : 'source',
            title: 'video',
            _type: 'video',
            formats,
            http_headers: safeHeaders(info.http_headers, platform),
          }),
          { mode: 0o600, flag: 'wx' },
        );
        const format =
          'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best';
        let download;
        try {
          download = await run(config.ytDlpPath, [
            ...base,
            '--load-info-json',
            metadataPath,
            '--downloader',
            'native',
            '--hls-prefer-native',
            ...(isAbsolute(config.ffmpegPath) ? ['--ffmpeg-location', config.ffmpegPath] : []),
            '-f',
            format,
            '--postprocessor-args',
            'ffmpeg_i:-protocol_whitelist file,pipe -format_whitelist mov,matroska,webm',
            '--merge-output-format',
            'mp4/mkv',
            '-o',
            join(ownedDirectory, 'video.%(ext)s'),
            '--fixup',
            'never',
            '--no-write-info-json',
            '--no-write-thumbnail',
            '--no-write-subs',
          ]);
        } finally {
          await rm(metadataPath, { force: true });
        }
        signal.throwIfAborted();
        if (guard.denied)
          throw new VideoError('NETWORK_SCOPE_DENIED', '媒体下载或跳转超出平台访问范围。');
        if (download.exitCode !== 0) throw classifyFailure(download.stderr);
        const names = await readdir(ownedDirectory);
        const files = names.filter((name) =>
          ['video.mp4', 'video.mkv', 'video.webm'].includes(name),
        );
        if (files.length !== 1)
          throw new VideoError('INVALID_MEDIA', '下载未产生唯一完整的视频文件。');
        const fileName = files[0]!;
        const filePath = join(ownedDirectory, fileName);
        const stat = await lstat(filePath);
        if (!stat.isFile() || stat.size <= 0)
          throw new VideoError('INVALID_MEDIA', '视频文件为空或类型不正确。');
        const inputFormat = fileName.endsWith('.mp4') ? 'mov' : 'matroska';
        const probe = await run(config.ffprobePath, [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          inputFormat,
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          filePath,
        ]);
        if (probe.exitCode !== 0)
          throw new VideoError('INVALID_MEDIA', '下载文件不能被媒体解析器读取。');
        const details = object(json(probe.stdout, 'INVALID_MEDIA'));
        const streams = Array.isArray(details.streams) ? details.streams.map(object) : [];
        const video = streams.find((stream) => stream.codec_type === 'video');
        const duration = Number(object(details.format).duration);
        if (
          !video ||
          !streams.some((stream) => stream.codec_type === 'audio') ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          typeof video.height !== 'number' ||
          typeof video.width !== 'number' ||
          !Number.isInteger(video.width) ||
          video.width <= 0 ||
          !Number.isInteger(video.height) ||
          video.height <= 0 ||
          Math.min(video.width, video.height) > config.maxResolution
        )
          throw new VideoError('INVALID_MEDIA', '视频必须有声音、有效时长，且符合配置的画质上限。');
        const decode = await run(config.ffmpegPath, [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-f',
          inputFormat,
          '-i',
          filePath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-f',
          'null',
          '-',
        ]);
        if (decode.exitCode !== 0)
          throw new VideoError('INVALID_MEDIA', '视频或音频未通过完整解码检查。');
        const result = FetchVideoResultSchema.parse({
          schemaVersion: '1.0',
          status: 'succeeded',
          sourceId: source.sourceId,
          videoAssetId,
          platform,
          durationSeconds: duration,
          sizeBytes: stat.size,
          width: video.width,
          height: video.height,
          container: extname(fileName).slice(1),
          hasAudio: true,
          sha256: await checksum(filePath, signal),
          fetchedAt: new Date().toISOString(),
          reused: false,
        }) as Success;
        await authorized(source.sourceId, signal);
        signal.throwIfAborted();
        await rm(privateTemp, { recursive: true, force: true });
        const manifest = {
          taskId: execution.taskId,
          execution,
          sourceFingerprint: key,
          fileName,
          result,
        };
        await writeFile(join(ownedDirectory, 'manifest.json'), JSON.stringify(manifest), {
          mode: 0o600,
          flag: 'wx',
        });
        const temporaryIndex = join(ownedDirectory, 'index.private.json');
        await writeFile(temporaryIndex, JSON.stringify({ videoAssetId }), {
          mode: 0o600,
          flag: 'wx',
        });
        await rename(temporaryIndex, indexPath);
        indexCommitted = true;
        signal.throwIfAborted();
        retained = true;
        return result;
      } catch (error) {
        const rejected = signal.aborted ? signal.reason : error;
        return failure(
          input.data.sourceId,
          rejected instanceof VideoError
            ? rejected
            : new VideoError(
                'STORAGE_ERROR',
                '视频处理失败，未采用结果；内部路径和原始错误已省略。',
              ),
        );
      }
    };
    const outcome = await execute();
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', cancel);
    let cleanupFailed = false;
    const cleanup = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch {
        cleanupFailed = true;
      }
    };
    if (guard) await cleanup(() => guard!.close());
    if (!retained && ownedDirectory) {
      await cleanup(() => rm(ownedDirectory!, { recursive: true, force: true }));
      if (indexCommitted && indexPath) await cleanup(() => rm(indexPath!, { force: true }));
    }
    if (lock) {
      await cleanup(() => lock!.close());
      if (lockPath) await cleanup(() => rm(lockPath!, { force: true }));
    }
    if (cleanupFailed)
      return failure(
        input.data.sourceId,
        new VideoError('STORAGE_ERROR', '视频资源清理或解锁失败，需要后端检查本次任务目录。'),
      );
    return outcome;
  }

  return {
    fetch,
    config: { ...config },
    execution: { ...execution },
    /** Host-side resource lookup for subsequent media tools; never exposed as an arbitrary path reader. */
    getAsset: readAsset,
  };
}

function safeHeaders(value: unknown, platform: VideoPlatform) {
  const headers: Record<string, string> = {};
  for (const [name, content] of Object.entries(object(value))) {
    if (
      !['user-agent', 'referer', 'origin', 'accept'].includes(name.toLowerCase()) ||
      typeof content !== 'string' ||
      /[\r\n]/.test(content) ||
      content.length > 8192
    )
      continue;
    if (name.toLowerCase() === 'referer' || name.toLowerCase() === 'origin')
      assertMediaUrl(content, platform);
    headers[name] = content;
  }
  return headers;
}

function safeFormat(format: Record<string, unknown>, platform: VideoPlatform) {
  const result: Record<string, unknown> = {};
  for (const key of [
    'url',
    'format_id',
    'ext',
    'width',
    'height',
    'fps',
    'vcodec',
    'acodec',
    'tbr',
    'abr',
    'vbr',
    'filesize',
    'duration',
    'language',
    'preference',
    'quality',
    'audio_channels',
    'asr',
  ]) {
    if (typeof format[key] === 'string' || typeof format[key] === 'number')
      result[key] = format[key];
  }
  result.protocol = 'https';
  result.http_headers = safeHeaders(format.http_headers, platform);
  return result;
}

function failure(sourceId: string | null, error: VideoError): FetchVideoResult {
  return {
    schemaVersion: '1.0',
    status: 'failed',
    sourceId,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}
