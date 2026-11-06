export const GITHUB_HOT_API_URL = 'https://v2.xxapi.cn/api/githubhot';

export interface GithubHotSnapshot {
  provider: 'xxapi';
  requestUrl: typeof GITHUB_HOT_API_URL;
  /** Local retrieval time, not the provider's ranking date or statistics window. */
  fetchedAt: string;
  /** Preserve the provider response, including the success marker 1. No ranking schema is assumed. */
  data: unknown;
}

export class GithubHotError extends Error {
  constructor(
    readonly code:
      | 'XXAPI_KEY_MISSING'
      | 'XXAPI_CONFIGURATION_INVALID'
      | 'XXAPI_CANCELLED'
      | 'XXAPI_TIMEOUT'
      | 'XXAPI_HTTP_ERROR'
      | 'XXAPI_INVALID_JSON'
      | 'XXAPI_NETWORK_ERROR',
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'GithubHotError';
  }
}

export interface GithubHotOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Offline tests inject a transport; production uses the project's native fetch. */
  fetch?: typeof globalThis.fetch;
}

/** One explicit read-only request. No automatic retries, logging, or model invocation. */
export async function fetchGithubHot(options: GithubHotOptions = {}): Promise<GithubHotSnapshot> {
  const apiKey = (options.env ?? process.env).XXAPI_ACCESS_KEY?.trim();
  if (!apiKey) throw new GithubHotError('XXAPI_KEY_MISSING', '缺少 XXAPI_ACCESS_KEY，未发起请求。');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (/\s/.test(apiKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new GithubHotError('XXAPI_CONFIGURATION_INVALID', 'API Key 或请求超时配置无效。');
  if (options.signal?.aborted)
    throw new GithubHotError('XXAPI_CANCELLED', 'GitHub 热榜请求已取消。');

  const controller = new AbortController();
  let cancelled: GithubHotError | undefined;
  let rejectStopped: (error: GithubHotError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  const cancel = () => {
    cancelled ??= new GithubHotError('XXAPI_CANCELLED', 'GitHub 热榜请求已取消。');
    controller.abort();
    rejectStopped(cancelled);
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    cancelled ??= new GithubHotError('XXAPI_TIMEOUT', 'GitHub 热榜请求超时。');
    controller.abort();
    rejectStopped(cancelled);
  }, timeoutMs);
  try {
    const request = async (): Promise<GithubHotSnapshot> => {
      const response = await (options.fetch ?? globalThis.fetch)(GITHUB_HOT_API_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        // The credential is only ever sent to the fixed provider endpoint.
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw cancelled;
      if (!response.ok)
        throw new GithubHotError(
          'XXAPI_HTTP_ERROR',
          `GitHub 热榜接口返回 HTTP ${response.status}。`,
          response.status,
        );
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new GithubHotError('XXAPI_INVALID_JSON', 'GitHub 热榜接口没有返回有效 JSON。');
      }
      if (controller.signal.aborted) throw cancelled;
      return {
        provider: 'xxapi',
        requestUrl: GITHUB_HOT_API_URL,
        fetchedAt: new Date().toISOString(),
        data,
      };
    };
    return await Promise.race([request(), stopped]);
  } catch (error) {
    if (cancelled) throw cancelled;
    if (error instanceof GithubHotError) throw error;
    // Do not propagate provider errors: they can contain request headers or response text.
    throw new GithubHotError('XXAPI_NETWORK_ERROR', 'GitHub 热榜接口请求失败，原始错误已省略。');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
