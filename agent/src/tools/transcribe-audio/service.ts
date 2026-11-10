import {
  TranscribeAudioInputSchema,
  TranscribeAudioResultSchema,
  TranscribeAudioSucceededSchema,
  TranscriptionRequestedLanguageSchema,
  type TranscribeAudioResult,
} from '@multi-agent-ops/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AudioError, type AudioAsset } from '../extract-audio/types.js';
import { runVideoProcess, videoProcessEnv } from '../fetch-video/process.js';
import { VideoError } from '../fetch-video/types.js';
import { validateTranscribeAudioConfig } from './config.js';
import { parseWhisperOutput } from './output.js';
import { TranscriptionError, type TranscriptAsset, type TranscribeAudioOptions } from './types.js';

const id = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const executionSchema = z.strictObject({
  taskId: id,
  attemptId: id,
  stepId: id,
  inputSnapshotId: id,
  authorizationId: id,
});
const profileSchema = z.strictObject({
  requestedLanguage: TranscriptionRequestedLanguageSchema,
  engineVersion: z.string().min(1).max(64),
  modelSha256: sha,
  threads: z.int().min(1).max(256),
});
type Profile = z.infer<typeof profileSchema>;
const rawFileSchema = z.strictObject({
  name: z.enum(['whisper.json', 'whisper.txt', 'whisper.srt']),
  sha256: sha,
  sizeBytes: z.int().nonnegative(),
});
const manifestSchema = z.strictObject({
  execution: executionSchema,
  audioAssetId: id,
  fingerprint: sha,
  profile: profileSchema,
  resultSha256: sha,
  resultSizeBytes: z.int().positive(),
  rawFiles: z.array(rawFileSchema).length(3),
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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
    throw new TranscriptionError('STORAGE_ERROR', '转写目录不能是符号链接。');
}
async function jsonFile(path: string, signal: AbortSignal, small = false): Promise<unknown> {
  signal.throwIfAborted();
  const stat = await lstat(path);
  if (!stat.isFile() || (small && stat.size > 64 * 1024)) throw new Error('Invalid result file');
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

/** One full local Whisper invocation; no network fallback, chunking, translation or automatic retry. */
export function createTranscribeAudioService(options: TranscribeAudioOptions) {
  const config = validateTranscribeAudioConfig(options.config);
  const execution = executionSchema.parse(options.execution);
  for (const key of ['taskId', 'attemptId', 'inputSnapshotId', 'authorizationId'] as const)
    if (execution[key] !== options.audioService.execution[key])
      throw new TranscriptionError(
        'CONFIGURATION_INVALID',
        '转写与音频资源服务必须绑定同一执行及授权。',
      );
  if (config.mediaRoot !== options.audioService.config.mediaRoot)
    throw new TranscriptionError('CONFIGURATION_INVALID', '转写与音频服务必须共用媒体资源根目录。');
  const runner = options.runProcess ?? runVideoProcess;
  const taskDirectory = join(config.mediaRoot, digest(execution.taskId));
  const fingerprint = (audio: AudioAsset, profile: Profile) =>
    digest(
      JSON.stringify([
        'transcribe_audio-v1-whole-original-segments',
        audio.result.audioAssetId,
        audio.result.sha256,
        audio.result.videoAssetId,
        audio.result.sourceId,
        audio.result.durationSeconds,
        audio.result.sourceTimeOffsetSeconds,
        profile.requestedLanguage,
        profile.engineVersion,
        profile.modelSha256,
        profile.threads,
      ]),
    );

  async function authorized(audioAssetId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const audio = await abortable(options.audioService.getAsset(audioAssetId, signal), signal);
    signal.throwIfAborted();
    if (!audio)
      throw new TranscriptionError('AUDIO_NOT_FOUND', '音频资源不存在、已损坏或不适用于当前任务。');
    if (audio.taskId !== execution.taskId || audio.result.audioAssetId !== audioAssetId)
      throw new TranscriptionError('SOURCE_NOT_AUTHORIZED', '音频资源不属于当前任务。');
    return audio;
  }
  async function modelDigest(signal: AbortSignal) {
    try {
      const stat = await lstat(config.modelPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error('Invalid model');
      return await checksum(config.modelPath, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new TranscriptionError(
        'MODEL_UNAVAILABLE',
        '本机模型文件缺失、不可读或无效；请检查后端模型配置，不会自动下载或切换模型。',
      );
    }
  }
  async function readAsset(
    transcriptAssetId: string,
    signal: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<TranscriptAsset | null> {
    signal.throwIfAborted();
    if (!/^transcript_[a-f0-9-]{36}$/.test(transcriptAssetId)) return null;
    const folder = join(taskDirectory, transcriptAssetId);
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
        (expectedFingerprint && expectedFingerprint !== manifest.fingerprint)
      )
        return null;
      const audio = await authorized(manifest.audioAssetId, signal);
      if (fingerprint(audio, manifest.profile) !== manifest.fingerprint) return null;
      const filePath = join(folder, 'result.json');
      const files = [
        { name: 'result.json', sha256: manifest.resultSha256, sizeBytes: manifest.resultSizeBytes },
        ...manifest.rawFiles,
      ];
      if (new Set(manifest.rawFiles.map((file) => file.name)).size !== 3) return null;
      for (const file of files) {
        const path = join(folder, file.name);
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.size !== file.sizeBytes ||
          (await realpath(path)) !== join(await realpath(folder), file.name) ||
          (await checksum(path, signal)) !== file.sha256
        )
          return null;
      }
      const result = TranscribeAudioSucceededSchema.parse(await jsonFile(filePath, signal));
      if (
        result.transcriptAssetId !== transcriptAssetId ||
        result.audioAssetId !== audio.result.audioAssetId ||
        result.videoAssetId !== audio.result.videoAssetId ||
        result.sourceId !== audio.result.sourceId ||
        result.durationSeconds !== audio.result.durationSeconds ||
        result.sourceTimeOffsetSeconds !== audio.result.sourceTimeOffsetSeconds ||
        result.requestedLanguage !== manifest.profile.requestedLanguage ||
        result.engineVersion !== manifest.profile.engineVersion ||
        result.modelSha256 !== manifest.profile.modelSha256
      )
        return null;
      await authorized(result.audioAssetId, signal);
      return { taskId: execution.taskId, execution: manifest.execution, filePath, result };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (
        error instanceof TranscriptionError ||
        error instanceof AudioError ||
        error instanceof VideoError
      )
        throw error;
      return null;
    }
  }

  async function transcribe(
    value: unknown,
    call: { signal?: AbortSignal } = {},
  ): Promise<TranscribeAudioResult> {
    const parsed = TranscribeAudioInputSchema.safeParse(value);
    if (!parsed.success)
      return failed(
        null,
        new TranscriptionError(
          'INVALID_INPUT',
          'transcribe_audio 只接受 audioAssetId 和可选的受支持语言代码。',
        ),
      );
    const { audioAssetId } = parsed.data;
    const requestedLanguage = parsed.data.language ?? 'auto';
    const controller = new AbortController();
    const cancel = () => controller.abort(new TranscriptionError('CANCELLED', '音频转写已取消。'));
    const timer = setTimeout(
      () =>
        controller.abort(
          new TranscriptionError('TIMEOUT', '音频转写超过配置的总时限；未采用部分结果。'),
        ),
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
    let result: TranscribeAudioResult;
    try {
      let audio = await authorized(audioAssetId, signal);
      await directory(config.mediaRoot);
      await directory(taskDirectory);
      const modelSha256 = await modelDigest(signal);
      const versionResult = await runner({
        executable: config.whisperPath,
        args: ['--version'],
        cwd: taskDirectory,
        env: videoProcessEnv(),
        signal,
      });
      signal.throwIfAborted();
      const engineVersion = /whisper\.cpp version:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/.exec(
        versionResult.stdout + '\n' + versionResult.stderr,
      )?.[1];
      if (versionResult.exitCode !== 0 || !engineVersion)
        throw new TranscriptionError(
          'DEPENDENCY_UNAVAILABLE',
          '无法确认本机 whisper-cli 版本，请检查后端可执行文件配置。',
        );
      const profile: Profile = {
        requestedLanguage,
        engineVersion,
        modelSha256,
        threads: config.threads,
      };
      const key = fingerprint(audio, profile);
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
      audio = await authorized(audioAssetId, signal);
      if (fingerprint(audio, profile) !== key)
        throw new TranscriptionError('AUDIO_NOT_FOUND', '等待期间音频资源已发生变化。');
      let cached: TranscriptAsset | null = null;
      try {
        const index = object(await jsonFile(indexPath, signal, true));
        if (typeof index.transcriptAssetId === 'string')
          cached = await readAsset(index.transcriptAssetId, signal, key);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (
          error instanceof TranscriptionError ||
          error instanceof AudioError ||
          error instanceof VideoError
        )
          throw error;
      }
      if (cached) {
        result = { ...cached.result, reused: true };
      } else {
        if (waited)
          throw new TranscriptionError(
            'TRANSCRIPTION_FAILED',
            '原转写没有产生可复用的完整结果；未自动重新执行。',
            true,
          );
        const transcriptAssetId = `transcript_${randomUUID()}`;
        folder = join(taskDirectory, transcriptAssetId);
        await directory(folder);
        const prefix = join(folder, 'whisper');
        const output = await runner({
          executable: config.whisperPath,
          args: [
            '-m',
            config.modelPath,
            '-f',
            audio.filePath,
            '-l',
            requestedLanguage,
            '-t',
            String(config.threads),
            '-np',
            '-oj',
            '-otxt',
            '-osrt',
            '-of',
            prefix,
          ],
          cwd: folder,
          env: videoProcessEnv(),
          signal,
          captureStdout: false,
        });
        signal.throwIfAborted();
        if (
          /out of memory|not enough memory|bad_alloc|cannot allocate memory|failed to allocate|failed to alloc|metal.*alloc.*fail/i.test(
            output.stderr,
          )
        )
          throw new TranscriptionError(
            'RESOURCE_EXHAUSTED',
            'Whisper 内存或计算资源不足；未切块、降级模型或采用部分结果。',
            true,
          );
        if (/no space left|disk full|disk quota exceeded/i.test(output.stderr))
          throw new TranscriptionError('STORAGE_ERROR', '转写存储空间不足；未采用部分结果。', true);
        if (output.exitSignal)
          throw new TranscriptionError(
            'PROCESS_TERMINATED',
            'Whisper 进程被系统信号终止，可能涉及资源不足；具体原因需检查本机，未采用部分结果。',
            true,
          );
        if (/failed to (open|load).*model|invalid model|unknown model/i.test(output.stderr))
          throw new TranscriptionError(
            'MODEL_UNAVAILABLE',
            'Whisper 无法加载后端配置的模型文件；不会自动下载或切换模型。',
          );
        if (output.exitCode !== 0)
          throw new TranscriptionError(
            'TRANSCRIPTION_FAILED',
            'Whisper 转写失败；原始输出和部分文字已省略，不会自动重试。',
          );
        let raw: unknown;
        try {
          raw = await jsonFile(`${prefix}.json`, signal);
        } catch {
          signal.throwIfAborted();
          throw new TranscriptionError(
            'INVALID_OUTPUT',
            'Whisper 未生成完整有效的 JSON 结果；不从日志或部分文本恢复结果。',
          );
        }
        result = parseWhisperOutput(raw, {
          audio,
          transcriptAssetId,
          requestedLanguage,
          engineVersion,
          modelSha256,
        });
        const rawFiles: z.infer<typeof rawFileSchema>[] = [];
        for (const name of ['whisper.json', 'whisper.txt', 'whisper.srt'] as const) {
          const path = join(folder, name);
          const stat = await lstat(path).catch(() => {
            throw new TranscriptionError(
              'INVALID_OUTPUT',
              'Whisper 原始结果文件缺失或不可读，结果未登记。',
            );
          });
          if (!stat.isFile() || (!result.empty && stat.size === 0))
            throw new TranscriptionError(
              'INVALID_OUTPUT',
              'Whisper 的原始转写文件不完整，结果未登记。',
            );
          await chmod(path, 0o600);
          rawFiles.push({ name, sha256: await checksum(path, signal), sizeBytes: stat.size });
        }
        const finalModelSha256 = await modelDigest(signal);
        const current = await authorized(audioAssetId, signal);
        if (fingerprint(current, profile) !== key || finalModelSha256 !== modelSha256)
          throw new TranscriptionError(
            'INVALID_OUTPUT',
            '处理期间音频资源或模型文件发生变化，结果未被采用。',
          );
        const resultPath = join(folder, 'result.json');
        await writeFile(resultPath, JSON.stringify(result), { mode: 0o600, flag: 'wx', signal });
        const stat = await lstat(resultPath);
        await writeFile(
          join(folder, 'manifest.json'),
          JSON.stringify({
            execution,
            audioAssetId,
            fingerprint: key,
            profile,
            resultSha256: await checksum(resultPath, signal),
            resultSizeBytes: stat.size,
            rawFiles,
          }),
          { mode: 0o600, flag: 'wx', signal },
        );
        const temporaryIndex = join(folder, 'index.private.json');
        await writeFile(temporaryIndex, JSON.stringify({ transcriptAssetId }), {
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
      result = failed(audioAssetId, signal.aborted ? signal.reason : error);
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
        audioAssetId,
        new TranscriptionError('STORAGE_ERROR', '转写残留清理失败，需要后端检查任务资源目录。'),
      );
    } finally {
      if (lock) {
        try {
          await lock.close();
          await rm(lockPath!, { force: true });
        } catch {
          result = failed(
            audioAssetId,
            new TranscriptionError('STORAGE_ERROR', '转写资源解锁失败，需要后端检查任务资源目录。'),
          );
        }
      }
    }
    return TranscribeAudioResultSchema.parse(result);
  }
  return {
    transcribe,
    execution: { ...execution },
    config: { ...config },
    getAsset: (id: string, signal: AbortSignal) => readAsset(id, signal),
  };
}

function failed(audioAssetId: string | null, error: unknown): TranscribeAudioResult {
  const normalized =
    error instanceof TranscriptionError
      ? error
      : error instanceof AudioError || error instanceof VideoError
        ? new TranscriptionError(
            error.code === 'SOURCE_NOT_AUTHORIZED'
              ? 'SOURCE_NOT_AUTHORIZED'
              : error.code === 'DEPENDENCY_UNAVAILABLE'
                ? 'DEPENDENCY_UNAVAILABLE'
                : 'AUDIO_NOT_FOUND',
            '资源授权、完整性或本地依赖检查失败。',
          )
        : new TranscriptionError('STORAGE_ERROR', '音频转写未完成；内部路径和原始输出已省略。');
  return {
    schemaVersion: '1.0',
    status: 'failed',
    audioAssetId,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
}
