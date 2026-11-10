import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { VideoError, type VideoProcessRunner } from './types.js';

// Never pass the service's database/model credentials or yt-dlp configuration through.
export function videoProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot'])
    if (env[name] !== undefined) result[name] = env[name];
  return result;
}

/** No shell. Output limits bound metadata/log buffers, not video size or process RAM. */
export const runVideoProcess: VideoProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) return reject(request.signal.reason);
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: unknown;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    let pendingLine = '';
    const observe = (text: string) => {
      if (!request.onStdoutLine || failure) return;
      pendingLine += text;
      let end: number;
      while ((end = pendingLine.indexOf('\n')) >= 0) {
        const line = pendingLine.slice(0, end);
        pendingLine = pendingLine.slice(end + 1);
        if (line.length > 64 * 1024) throw new Error('媒体元数据行过长。');
        request.onStdoutLine(line);
      }
      if (pendingLine.length > 64 * 1024) throw new Error('媒体元数据行过长。');
    };
    function kill(signal: NodeJS.Signals) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // A process can exit between the abort event and the signal.
      }
    }
    function stop(reason: unknown) {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 500);
    }
    const abort = () => stop(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        observe(decoder.write(chunk));
      } catch (error) {
        stop(error);
      }
      if (request.captureStdout !== false) {
        outBytes += chunk.length;
        if (outBytes > 4 * 1024 * 1024)
          stop(new VideoError('DOWNLOAD_FAILED', '视频元数据输出超过工具缓冲上限。'));
        else stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < 64 * 1024) stderr.push(chunk.subarray(0, 64 * 1024 - errBytes));
      errBytes += chunk.length;
    });
    child.on('error', () => {
      failure ??= new VideoError(
        'DEPENDENCY_UNAVAILABLE',
        '无法启动视频运行依赖，请检查安装路径。',
      );
    });
    child.on('close', (code, exitSignal) => {
      try {
        observe(decoder.end());
        if (!failure && pendingLine && request.onStdoutLine) request.onStdoutLine(pendingLine);
      } catch (error) {
        failure ??= error;
      }
      if (failure) kill('SIGKILL');
      if (escalation) clearTimeout(escalation);
      request.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else
        resolve({
          exitCode: code ?? -1,
          ...(exitSignal ? { exitSignal } : {}),
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    });
  });
