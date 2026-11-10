import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { VideoError, type VideoPlatform } from './types.js';

const domains: Record<VideoPlatform, string[]> = {
  bilibili: [
    'bilibili.com',
    'b23.tv',
    'bilivideo.com',
    'bilivideo.cn',
    'bilivideo.net',
    'hdslb.com',
  ],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhscdn.com'],
};
const belongs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function allowedVideoHost(host: string, platform: VideoPlatform): boolean {
  return domains[platform].some((domain) => belongs(host.toLowerCase(), domain));
}

export function videoPlatform(value: string): VideoPlatform {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VideoError('URL_NOT_ALLOWED', '已登记来源没有有效的视频链接。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new VideoError(
      'URL_NOT_ALLOWED',
      '视频来源必须是无凭据、使用标准 HTTPS 端口的平台链接。',
    );
  if (belongs(url.hostname, 'douyin.com') || belongs(url.hostname, 'iesdouyin.com'))
    throw new VideoError(
      'PLATFORM_NOT_ENABLED',
      '抖音视频下载暂未启用，请将不可读取内容记为资料缺口。',
    );
  if (belongs(url.hostname, 'bilibili.com') || url.hostname === 'b23.tv') return 'bilibili';
  if (belongs(url.hostname, 'xiaohongshu.com') || belongs(url.hostname, 'xhslink.com'))
    return 'xiaohongshu';
  throw new VideoError('URL_NOT_ALLOWED', '首版仅允许 B 站和小红书的视频来源。');
}

export function assertMediaUrl(value: string, platform: VideoPlatform): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !allowedVideoHost(url.hostname, platform)
  )
    throw new VideoError('NETWORK_SCOPE_DENIED', '媒体地址超出已配置的平台及 CDN 访问范围。');
}

/** IPv4 only: the downloader and proxy both resolve/connect using IPv4. */
export function isPublicVideoAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * All yt-dlp HTTPS requests (including redirects) pass through this per-call proxy.
 * It validates each target and pins the public DNS result before opening a tunnel.
 * No cookies, headers, request paths or signed URLs are logged by the proxy.
 */
export async function openVideoNetworkGuard(platform: VideoPlatform, signal: AbortSignal) {
  const sockets = new Set<Socket>();
  let closed = false;
  let denied = false;
  const server = createServer((_request, response) => {
    denied = true;
    response.writeHead(403).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => {
    void (async () => {
      const target = new URL(`https://${request.url ?? ''}`);
      if (
        target.username ||
        target.password ||
        target.port ||
        target.pathname !== '/' ||
        !allowedVideoHost(target.hostname, platform)
      ) {
        denied = true;
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const records = await lookup(target.hostname, { all: true, family: 4 });
      if (!records.length || records.some((record) => !isPublicVideoAddress(record.address))) {
        denied = true;
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (closed || signal.aborted || client.destroyed) return client.destroy();
      const upstream = connect({ host: records[0]!.address, port: 443, family: 4 });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      upstream.setTimeout(15_000, () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        if (closed || signal.aborted) return upstream.destroy();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch(() => client.destroy());
  });
  const abort = () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const address = server.address();
  if (!address || typeof address === 'string') {
    abort();
    throw signal.reason ?? new VideoError('NETWORK_ERROR', '无法建立视频访问范围校验。');
  }
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    get denied() {
      return denied;
    },
    async close() {
      signal.removeEventListener('abort', abort);
      abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
