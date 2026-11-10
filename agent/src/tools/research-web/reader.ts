import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { ResearchWebConfig } from '@multi-agent-ops/shared';
import { isPublicVideoAddress } from '../fetch-video/network.js';
import { ResearchWebError } from './config.js';
import { canonicalWebUrl } from './scope.js';

export interface OriginalPage {
  finalUrl: string;
  redirects: string[];
  text: string;
  truncated: boolean;
  responseSha256: string;
  links: readonly string[];
  textOffset?: number;
  nextOffset?: number | null;
  mediaKind: 'text' | 'mixed' | 'video';
}
export type OriginalReader = (
  url: string,
  options: {
    config: ResearchWebConfig;
    signal: AbortSignal;
    allowed: (url: string) => boolean;
    offset?: number;
  },
) => Promise<OriginalPage>;

/** Returns only the text actually extracted, not a model's summary of the HTML. */
export function extractPage(body: string, html: boolean, base: string, limit: number, offset = 0) {
  const links: string[] = [];
  const chunks: string[] = [];
  let hasVideo = false;
  if (html) {
    const document = parse(body);
    const skip = new Set([
      'head',
      'script',
      'style',
      'noscript',
      'template',
      'iframe',
      'svg',
      'canvas',
      'nav',
      'footer',
      'aside',
      'form',
      'button',
    ]);
    const visit = (node: DefaultTreeAdapterTypes.Node) => {
      if (node.nodeName === '#text') {
        chunks.push((node as DefaultTreeAdapterTypes.TextNode).value);
        return;
      }
      if ('tagName' in node) {
        if (node.tagName === 'video') hasVideo = true;
        if (
          skip.has(node.tagName) ||
          node.attrs.some(
            (a) => a.name === 'hidden' || (a.name === 'aria-hidden' && a.value === 'true'),
          )
        )
          return;
        if (node.tagName === 'a' && links.length < 1000) {
          const href = node.attrs.find((a) => a.name === 'href')?.value;
          if (href)
            try {
              links.push(canonicalWebUrl(new URL(href, base).href));
            } catch {
              /* Unusable links are not source permissions. */
            }
        }
        if (
          ['p', 'div', 'li', 'br', 'section', 'article', 'h1', 'h2', 'h3', 'pre', 'tr'].includes(
            node.tagName,
          )
        )
          chunks.push('\n');
      }
      if ('childNodes' in node) for (const child of node.childNodes) visit(child);
      if (
        'tagName' in node &&
        ['p', 'div', 'li', 'section', 'article', 'pre', 'tr'].includes(node.tagName)
      )
        chunks.push('\n');
    };
    visit(document);
  } else chunks.push(body);
  const full = chunks
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0 ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Offsets in material text use UTF-16; avoid ending a retained prefix inside a surrogate pair.
  let start = Math.min(offset, full.length);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(full[start] ?? '')) start--;
  let text = full.slice(start, start + limit);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return {
    text,
    truncated: start > 0 || start + text.length < full.length,
    textOffset: start,
    nextOffset: start + text.length < full.length ? start + text.length : null,
    links: [...new Set(links)],
    mediaKind: hasVideo ? (text ? 'mixed' : 'video') : 'text',
  } as const;
}

export interface OriginalReaderDependencies {
  resolve?: (hostname: string) => Promise<string[]>;
  exchange?: (url: URL, address: string, signal: AbortSignal) => Promise<IncomingMessage>;
}
export async function assertPublicWebHost(value: string): Promise<void> {
  const records = await lookup(new URL(canonicalWebUrl(value)).hostname, { all: true, family: 4 });
  if (!records.length || records.some((r) => !isPublicVideoAddress(r.address)))
    throw new ResearchWebError('PRIVATE_ADDRESS_DENIED');
}
async function open(
  url: URL,
  signal: AbortSignal,
  deps: OriginalReaderDependencies,
): Promise<IncomingMessage> {
  signal.throwIfAborted();
  const addresses = await (deps.resolve?.(url.hostname) ??
    lookup(url.hostname, { all: true, family: 4 }).then((records) =>
      records.map((r) => r.address),
    ));
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !isPublicVideoAddress(a)))
    throw new ResearchWebError('PRIVATE_ADDRESS_DENIED');
  return (deps.exchange ?? exchange)(url, addresses[0]!, signal);
}
async function exchange(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      method: 'GET',
      agent: false,
      family: 4,
      signal,
      maxHeaderSize: 32768,
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'MultiAgentOps-Research/1.0',
      },
      // Pin this validated IPv4 address; TLS still validates the original hostname.
      lookup: (_host, _options, callback) => callback(null, address, 4),
    };
    const req = request(url, opts, resolve);
    req.once('error', () =>
      reject(new ResearchWebError(signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR')),
    );
    req.end();
  });
}
async function readBody(res: IncomingMessage, cap: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'br'
        ? createBrotliDecompress()
        : encoding === 'deflate'
          ? createInflate()
          : null;
  if (!decoder && encoding !== 'identity') {
    res.destroy();
    throw new ResearchWebError('CONTENT_ENCODING_UNSUPPORTED');
  }
  const stream = decoder ? res.pipe(decoder) : res;
  const abort = () => {
    res.destroy();
    stream.destroy(new ResearchWebError('CANCELLED'));
  };
  const responseError = () => stream.destroy(new ResearchWebError('NETWORK_ERROR'));
  res.on('error', responseError);
  signal.addEventListener('abort', abort, { once: true });
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > cap) throw new ResearchWebError('RESPONSE_TOO_LARGE');
      parts.push(part);
    }
    if (!res.complete) throw new ResearchWebError('INCOMPLETE_RESPONSE');
    signal.throwIfAborted();
    return Buffer.concat(parts);
  } finally {
    signal.removeEventListener('abort', abort);
    res.removeListener('error', responseError);
    res.destroy();
    stream.destroy();
  }
}

/** Independent verification only. No browser/Cookie/proxy credentials and no automatic retries. */
export function createOriginalReader(deps: OriginalReaderDependencies = {}): OriginalReader {
  return async (value, { config, signal, allowed, offset }) => {
    let current = canonicalWebUrl(value);
    const redirects: string[] = [];
    try {
      for (let i = 0; i <= config.maxRedirects; i++) {
        if (!allowed(current)) throw new ResearchWebError('REDIRECT_SCOPE_DENIED');
        const response = await open(new URL(current), signal, deps);
        const code = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || i === config.maxRedirects) throw new ResearchWebError('REDIRECT_LIMIT');
          current = canonicalWebUrl(new URL(location, current).href);
          redirects.push(current);
          continue;
        }
        if (code !== 200) {
          response.destroy();
          throw new ResearchWebError(`HTTP_${code}`);
        }
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        if (!/^(text\/(?:html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/.test(contentType)) {
          response.destroy();
          throw new ResearchWebError('CONTENT_TYPE_UNSUPPORTED');
        }
        const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
        if (!['utf-8', 'utf8', 'us-ascii'].includes(charset)) {
          response.destroy();
          throw new ResearchWebError('CHARSET_UNSUPPORTED');
        }
        const bytes = await readBody(response, config.maxResponseBytes, signal);
        let body: string;
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new ResearchWebError('TEXT_DECODE_FAILED');
        }
        const extracted = extractPage(
          body,
          /html/.test(contentType),
          current,
          config.maxTextCharacters,
          offset,
        );
        if (!extracted.text) throw new ResearchWebError('NO_TEXT');
        return {
          finalUrl: current,
          redirects,
          responseSha256: createHash('sha256').update(bytes).digest('hex'),
          ...extracted,
        };
      }
      throw new ResearchWebError('REDIRECT_LIMIT');
    } catch (error) {
      throw error instanceof ResearchWebError
        ? error
        : new ResearchWebError(signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR');
    }
  };
}
export const readOriginalPage = createOriginalReader();
