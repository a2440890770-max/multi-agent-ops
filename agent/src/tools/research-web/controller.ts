import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ResearchWebSnapshotSchema,
  ResearchToolAttemptSchema,
  ResearchWebConfigSchema,
  validateResearchContext,
  type ResearchContext,
  type ResearchWebConfig,
  type ResearchWebSnapshot,
  type ResearchWebCall,
  type OfficialSiteGrant,
  type ResearchAcceptedResult,
} from '@multi-agent-ops/shared';
import { readResearchWebConfig, ResearchWebError } from './config.js';
import { createWebScope, canonicalWebUrl } from './scope.js';
import { readOriginalPage, assertPublicWebHost, type OriginalReader } from './reader.js';

export interface ResearchWebOptions {
  onSnapshot?: (snapshot: ResearchWebSnapshot) => Promise<void>;
  config?: ResearchWebConfig;
  officialSites?: OfficialSiteGrant[];
  /** Trusted transport injection for fixed-fixture tests; never model input. */
  readOriginal?: OriginalReader;
  checkPublicAddress?: (url: string) => Promise<void>;
}
export interface WebToolRequest {
  researchContext: ResearchContext;
  toolName: 'WebSearch' | 'WebFetch';
  toolInput: unknown;
  toolUseId: string;
  signal: AbortSignal;
  onTimeout: () => void;
}
type Pending = {
  call: ResearchWebCall;
  input: Record<string, unknown>;
  domains: string[];
  signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  sessionSignal: AbortSignal;
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();

export function createResearchWebController(options: ResearchWebOptions = {}) {
  const config = ResearchWebConfigSchema.parse(options.config ?? readResearchWebConfig());
  let context: ResearchContext | undefined;
  let scope: ReturnType<typeof createWebScope> | undefined;
  let snapshot: ResearchWebSnapshot | undefined;
  let directory: string | undefined;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  let closed = false;
  const pending = new Map<string, Pending>();
  const urlIds = new Map<string, string>();
  let searches = 0;
  let fetches = 0;

  const save = () => {
    if (!snapshot || !directory) throw new ResearchWebError('REGISTRY_NOT_BOUND');
    const data = JSON.stringify(ResearchWebSnapshotSchema.parse(snapshot));
    const dest = directory;
    writes = writes.then(async () => {
      const tmp = join(dest, `pending-${randomUUID()}.json`);
      try {
        await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
        await rename(tmp, join(dest, 'registry.json'));
        await options.onSnapshot?.(JSON.parse(data) as ResearchWebSnapshot);
      } finally {
        await rm(tmp, { force: true });
      }
    });
    return writes;
  };
  function addSource(
    url: string,
    label: string,
    via: ResearchWebSnapshot['sources'][number]['discoveredBy'],
    parent: string | null,
    toolUseId: string | null,
  ) {
    const normalized = canonicalWebUrl(url);
    const existing = urlIds.get(normalized);
    const nature = scope!.official(normalized)
      ? 'primary'
      : scope!.platform(normalized)
        ? 'third_party'
        : 'unknown';
    const previous = existing ? snapshot!.sources.find((s) => s.source.id === existing) : undefined;
    if (previous && previous.source.nature === nature) return previous;
    const record: ResearchWebSnapshot['sources'][number] = {
      source: {
        id: `source_${randomUUID()}`,
        label: label || normalized,
        url: normalized,
        nature,
        author: null,
        publishedAt: null,
      },
      discoveredBy: via,
      parentSourceId: parent ?? previous?.source.id ?? null,
      toolUseId,
    };
    snapshot!.sources.push(record);
    urlIds.set(normalized, record.source.id);
    return record;
  }
  async function bind(value: ResearchContext) {
    const parsed = validateResearchContext(value);
    if (closed) throw new ResearchWebError('REGISTRY_CLOSED');
    if (context && !same(context, parsed)) throw new ResearchWebError('REGISTRY_SCOPE_MISMATCH');
    if (initialization) return initialization;
    context = parsed;
    scope = createWebScope(parsed, options.officialSites ?? []);
    snapshot = {
      schemaVersion: '1.0',
      execution: parsed.execution,
      authorizationId: parsed.authorization.id,
      selectedProject: parsed.selectedProject,
      policy: {
        version: 'research-web-d9-v1',
        config: { ...config },
        officialSites: structuredClone(options.officialSites ?? []),
      },
      sources: [],
      materials: [],
      calls: [],
    };
    initialization = (async () => {
      const base = join(
        config.root,
        sha(parsed.execution.taskId),
        sha(`${parsed.execution.attemptId}:${parsed.authorization.id}`),
      );
      await mkdir(base, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(base, 'web-'));
      const seed = (
        r: ResearchAcceptedResult | ResearchContext['referenceMaterials'],
        via: 'input' | 'history',
      ) => {
        for (const s of r.sources) {
          const old = snapshot!.sources.find((item) => item.source.id === s.id);
          if (old && !same(old.source, s)) throw new ResearchWebError('SEED_SOURCE_CONFLICT');
          if (!old)
            snapshot!.sources.push({
              source: structuredClone(s),
              discoveredBy: via,
              parentSourceId: null,
              toolUseId: null,
            });
          if (s.url)
            try {
              urlIds.set(canonicalWebUrl(s.url), s.id);
            } catch {
              /* Unsupported URLs remain inert input clues. */
            }
        }
        for (const m of r.materials) {
          const old = snapshot!.materials.find((item) => item.material.id === m.id);
          if (old && !same(old.material, m)) throw new ResearchWebError('SEED_MATERIAL_CONFLICT');
          if (!old)
            snapshot!.materials.push({
              material: structuredClone(m),
              method: 'provided',
              contentSha256: sha(m.content ?? JSON.stringify(m.assetIds)),
              responseSha256: null,
              finalUrl: null,
              redirects: [],
              toolUseId: null,
              extractionVersion: 'provided-v1',
              textOffset: null,
            });
        }
      };
      if (parsed.previousReport) seed(parsed.previousReport, 'history');
      seed(parsed.referenceMaterials, 'input');
      // A new explicit site grant can classify a formerly unknown clue. Allocate a
      // new source ID so the previous report's source metadata stays immutable.
      for (const entry of [...snapshot!.sources])
        if (entry.source.url)
          try {
            if (scope!.official(entry.source.url) || scope!.platform(entry.source.url))
              addSource(
                entry.source.url,
                entry.source.label,
                entry.discoveredBy,
                entry.parentSourceId,
                null,
              );
          } catch {
            /* An unsupported URL never becomes newly readable. */
          }
      addSource(
        parsed.selectedProject.repositoryUrl,
        parsed.selectedProject.name,
        'project',
        null,
        null,
      );
      await save();
    })();
    return initialization;
  }
  function finish(p: Pending, status: ResearchWebCall['status'], errorCode: string | null) {
    clearTimeout(p.timer);
    p.sessionSignal.removeEventListener('abort', p.abort);
    p.call.status = status;
    p.call.errorCode = errorCode;
    p.call.finishedAt = now();
    pending.delete(p.call.toolUseId);
  }
  async function prepare(request: WebToolRequest) {
    await bind(request.researchContext);
    request.signal.throwIfAborted();
    if (snapshot!.calls.some((c) => c.toolUseId === request.toolUseId))
      throw new ResearchWebError('TOOL_CALL_DUPLICATE');
    const input = object(request.toolInput);
    let updated: Record<string, unknown> = {};
    let domains: string[] = [];
    let site: ResearchWebCall['site'] = null;
    let sourceId: string | null = null;
    let rejection: string | null = null;
    try {
      if (request.toolName === 'WebSearch') {
        const parsed = scope!.search(input);
        updated = parsed.input;
        domains = parsed.domains;
        site = parsed.site;
        if (
          searches >= Math.min(config.maxSearchCalls, context!.runtimeContext.limits.maxSearchCalls)
        )
          throw new ResearchWebError('SEARCH_LIMIT_REACHED');
      } else {
        const parsed = z
          .strictObject({
            url: z.string(),
            prompt: z.string().max(16000),
            offset: z.int().nonnegative().optional(),
          })
          .parse(input);
        const url = canonicalWebUrl(parsed.url);
        sourceId = urlIds.get(url) ?? null;
        if (!sourceId || !scope!.readable(url)) throw new ResearchWebError('SOURCE_NOT_AUTHORIZED');
        if (fetches >= Math.min(config.maxFetchCalls, context!.runtimeContext.limits.maxFetchCalls))
          throw new ResearchWebError('FETCH_LIMIT_REACHED');
        updated = { ...parsed, url };
      }
    } catch (error) {
      rejection = error instanceof ResearchWebError ? error.code : 'TOOL_INPUT_INVALID';
    }
    const call: ResearchWebCall = {
      id: `webcall_${randomUUID()}`,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      query:
        request.toolName === 'WebSearch' && typeof input.query === 'string' ? input.query : null,
      site,
      sourceId,
      status: rejection ? 'denied' : 'running',
      errorCode: rejection,
      startedAt: now(),
      finishedAt: rejection ? now() : null,
      deadlineAt: new Date(Date.now() + config.timeoutMs).toISOString(),
      countsTowardLimit: !rejection,
      sdkNetworkAttempts: 'unobserved',
      sourceIds: [],
      materialIds: [],
    };
    snapshot!.calls.push(call);
    if (rejection) {
      await save();
      return { allowed: false, reason: rejection };
    }
    if (request.toolName === 'WebSearch') searches++;
    else fetches++;
    const local = new AbortController();
    const expire = () => {
      local.abort();
      const p = pending.get(request.toolUseId);
      if (p) {
        finish(p, 'failed', 'TOOL_TIMEOUT');
        void save().catch(() => {});
      }
      request.onTimeout();
    };
    const abort = () => {
      local.abort();
      const p = pending.get(request.toolUseId);
      if (p) {
        finish(p, 'failed', 'CANCELLED');
        void save().catch(() => {});
      }
    };
    const p: Pending = {
      call,
      input: updated,
      domains,
      signal: AbortSignal.any([request.signal, local.signal]),
      timer: setTimeout(expire, config.timeoutMs),
      abort,
      sessionSignal: request.signal,
    };
    pending.set(request.toolUseId, p);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    await save();
    p.signal.throwIfAborted();
    if (request.toolName === 'WebFetch') {
      try {
        await abortable(
          (options.checkPublicAddress ?? assertPublicWebHost)(String(updated.url)),
          p.signal,
        );
      } catch (error) {
        if (p.signal.aborted) throw error;
        finish(p, 'denied', error instanceof ResearchWebError ? error.code : 'DNS_LOOKUP_FAILED');
        p.call.countsTowardLimit = false;
        fetches--;
        await save();
        return { allowed: false, reason: p.call.errorCode! };
      }
    }
    return { allowed: true, input: updated };
  }
  function material(
    p: Pending,
    sourceId: string,
    kind: 'webpage_text' | 'search_snippet' | 'sdk_processed',
    text: string,
    truncated: boolean,
    extra: {
      responseSha256?: string;
      finalUrl?: string;
      redirects?: string[];
      textOffset?: number;
    } = {},
  ) {
    p.signal.throwIfAborted();
    const id = `material_${randomUUID()}`;
    const version =
      1 +
      snapshot!.materials
        .filter((m) => m.material.sourceId === sourceId && m.material.kind === kind)
        .reduce((v, m) => Math.max(v, m.material.version), 0);
    const entry: ResearchWebSnapshot['materials'][number] = {
      material: {
        id,
        sourceId,
        version,
        kind,
        content: text,
        assetIds: [],
        segments: [],
        framePositions: [],
        capturedAt: now(),
        truncated,
        coverage: null,
        firstHandConfirmation: null,
      },
      method: kind === 'webpage_text' ? 'independent_body' : kind,
      contentSha256: sha(text),
      responseSha256: extra.responseSha256 ?? null,
      finalUrl: extra.finalUrl ?? null,
      redirects: extra.redirects ?? [],
      toolUseId: p.call.toolUseId,
      extractionVersion: 'parse5-text-v1',
      textOffset: extra.textOffset ?? null,
    };
    snapshot!.materials.push(entry);
    p.call.materialIds.push(id);
    return entry.material;
  }
  async function complete(toolUseId: string, raw: unknown) {
    const p = pending.get(toolUseId);
    if (!p) throw new ResearchWebError('TOOL_CALL_NOT_ACTIVE');
    p.signal.throwIfAborted();
    const result = object(raw);
    const warnings: { code: string; message: string; relatedRefs: string[] }[] = [];
    if (p.call.toolName === 'WebSearch') {
      if (!Array.isArray(result.results)) return failure(toolUseId, 'SDK_RESULT_INVALID');
      const hits: {
        sourceId: string;
        title: string;
        url: string;
        snippetMaterialId: string | null;
      }[] = [];
      let recognized = result.results.length === 0;
      for (const group of result.results) {
        const entries = object(group).content;
        if (!Array.isArray(entries)) continue;
        recognized = true;
        for (const entry of entries) {
          if (hits.length >= config.maxSearchResults) break;
          const hit = object(entry);
          if (typeof hit.title !== 'string' || typeof hit.url !== 'string') continue;
          try {
            const url = canonicalWebUrl(hit.url);
            const host = new URL(url).hostname;
            if (
              !p.domains.some((d) => host === d || host.endsWith(`.${d}`)) ||
              !(scope!.official(url) || scope!.platform(url))
            )
              continue;
            const source = addSource(url, hit.title, 'search', null, toolUseId);
            if (hits.some((h) => h.sourceId === source.source.id)) continue;
            p.call.sourceIds.push(source.source.id);
            const snippet =
              typeof hit.snippet === 'string'
                ? material(
                    p,
                    source.source.id,
                    'search_snippet',
                    hit.snippet.slice(0, config.maxTextCharacters),
                    hit.snippet.length > config.maxTextCharacters,
                  )
                : null;
            hits.push({
              sourceId: source.source.id,
              title: source.source.label,
              url,
              snippetMaterialId: snippet?.id ?? null,
            });
          } catch (error) {
            if (p.signal.aborted) throw error;
          }
        }
      }
      if (!recognized) return failure(toolUseId, 'SDK_RESULT_INVALID');
      finish(p, hits.length ? 'succeeded' : 'no_results', null);
      await save();
      return {
        status: p.call.status,
        callId: p.call.id,
        hits,
        materials: snapshot!.materials
          .filter((m) => p.call.materialIds.includes(m.material.id))
          .map((m) => m.material),
        notice: '搜索结果和摘要仅为线索，不代表读过网页正文。',
      };
    }
    if (result.code !== 200 || typeof result.result !== 'string' || typeof result.url !== 'string')
      return failure(
        toolUseId,
        typeof result.code === 'number' ? `SDK_HTTP_${result.code}` : 'SDK_RESULT_INVALID',
      );
    let returnedUrl: string;
    try {
      returnedUrl = canonicalWebUrl(result.url);
      if (!scope!.readable(returnedUrl)) throw new ResearchWebError('SDK_FINAL_URL_DENIED');
    } catch {
      return failure(toolUseId, 'SDK_FINAL_URL_DENIED');
    }
    const sourceId = p.call.sourceId!;
    p.call.sourceIds.push(sourceId);
    const processed = material(
      p,
      sourceId,
      'sdk_processed',
      result.result.slice(0, config.maxTextCharacters),
      result.result.length > config.maxTextCharacters,
      { finalUrl: returnedUrl },
    );
    let original: ReturnType<typeof material> | null = null;
    let nextOffset: number | null = null;
    let contentKind = 'unknown';
    try {
      const reading = (options.readOriginal ?? readOriginalPage)(String(p.input.url), {
        config,
        signal: p.signal,
        allowed: scope!.readable,
        ...(typeof p.input.offset === 'number' ? { offset: p.input.offset } : {}),
      });
      // An injected/broken reader cannot keep the hook alive after a session/tool deadline.
      const page = await abortable(reading, p.signal);
      p.signal.throwIfAborted();
      nextOffset = page.nextOffset ?? null;
      contentKind = page.mediaKind;
      if (!scope!.readable(page.finalUrl) || page.redirects.some((url) => !scope!.readable(url)))
        throw new ResearchWebError('REDIRECT_SCOPE_DENIED');
      original = material(
        p,
        sourceId,
        'webpage_text',
        page.text.slice(0, config.maxTextCharacters),
        page.truncated || page.text.length > config.maxTextCharacters,
        {
          responseSha256: page.responseSha256,
          finalUrl: page.finalUrl,
          redirects: page.redirects,
          textOffset: page.textOffset ?? 0,
        },
      );
      for (const link of page.links)
        try {
          addSource(link, link, 'document_link', sourceId, toolUseId);
        } catch {
          /* No permission comes from link text. */
        }
      if (original.truncated)
        warnings.push({
          code: 'TEXT_TRUNCATED',
          message: '正文仅保留已保存部分，不能声称读过全文。',
          relatedRefs: [original.id],
        });
      finish(p, 'succeeded', null);
    } catch (error) {
      if (p.signal.aborted) throw new ResearchWebError('CANCELLED');
      const code = error instanceof ResearchWebError ? error.code : 'ORIGINAL_READ_FAILED';
      warnings.push({
        code,
        message: '独立原文读取失败；SDK 处理结果仅作线索，不能作为原文证据。',
        relatedRefs: [p.call.id, processed.id],
      });
      finish(p, 'failed', code);
    }
    await save();
    return {
      status: original ? 'succeeded' : 'partial',
      callId: p.call.id,
      sourceId,
      processed,
      original,
      warnings,
      nextOffset,
      contentKind,
      offsetNotice:
        'offset 对独立正文指提取器生成文本的 UTF-16 偏移；SDK 自身的文本位置可能不同。原文证据的位置引用本次 material.content。',
      relatedSources: snapshot!.sources
        .filter((s) => s.parentSourceId === sourceId)
        .slice(0, config.maxSearchResults)
        .map((s) => ({
          source: s.source,
          readable: s.source.url !== null && scope!.readable(s.source.url),
        })),
    };
  }
  async function failure(toolUseId: string, code = 'SDK_TOOL_FAILED') {
    const p = pending.get(toolUseId);
    if (!p) throw new ResearchWebError('TOOL_CALL_NOT_ACTIVE');
    p.signal.throwIfAborted();
    finish(p, 'failed', code);
    await save();
    return {
      status: 'failed',
      callId: p.call.id,
      errorCode: code,
      notice:
        '工具未自动重试。Research 可在本轮剩余额度内决定是否再次调用；新调用独立计时，不能将失败视为取得资料。',
    };
  }
  async function getSnapshot() {
    await initialization;
    await writes;
    if (!snapshot) throw new ResearchWebError('REGISTRY_NOT_BOUND');
    return structuredClone(ResearchWebSnapshotSchema.parse(snapshot));
  }
  async function resolveSource(sourceId: string) {
    const state = await getSnapshot();
    const source = state.sources.find((s) => s.source.id === sourceId)?.source;
    if (!source?.url || !scope!.readable(source.url)) return null;
    return {
      sourceId,
      taskId: state.execution.taskId,
      authorizationId: state.authorizationId,
      url: source.url,
    };
  }
  async function getRecords() {
    const state = await getSnapshot();
    if (state.calls.some((c) => c.status === 'running'))
      throw new ResearchWebError('WEB_CALLS_PENDING');
    return {
      sources: state.sources.map((s) => s.source),
      materials: state.materials.map((m) => m.material),
      toolAttempts: state.calls
        .filter((c) => c.countsTowardLimit)
        .map((c) =>
          ResearchToolAttemptSchema.parse({
            id: c.id,
            toolUseId: c.toolUseId,
            toolName: c.toolName,
            site: c.site,
            query: c.query,
            sourceId: c.sourceId,
            status: c.status,
            errorCode: c.errorCode,
            startedAt: c.startedAt,
            finishedAt: c.finishedAt,
          }),
        ),
    };
  }
  async function validateResultRecords(result: ResearchAcceptedResult) {
    const state = await getSnapshot();
    if (state.calls.some((c) => c.status === 'running'))
      throw new ResearchWebError('WEB_CALLS_PENDING');
    if (
      result.report.status === 'completed' &&
      context!.runtimeContext.requiredSearchSites.some(
        (site) =>
          !state.calls.some(
            (c) => c.toolName === 'WebSearch' && c.site === site && c.countsTowardLimit,
          ),
      )
    )
      throw new ResearchWebError('CURRENT_ROUND_SEARCH_MISSING');
    for (const source of result.sources)
      if (!state.sources.some((s) => same(s.source, source)))
        throw new ResearchWebError('UNREGISTERED_REPORT_SOURCE');
    for (const m of result.materials)
      if (
        !['transcript', 'subtitles', 'frames'].includes(m.kind) &&
        !state.materials.some((record) => same(record.material, m))
      )
        throw new ResearchWebError('UNREGISTERED_REPORT_MATERIAL');
    const calls = state.calls.filter((c) => c.countsTowardLimit && c.status !== 'running');
    for (const call of calls) {
      const expected = {
        id: call.id,
        toolUseId: call.toolUseId,
        toolName: call.toolName,
        site: call.site,
        query: call.query,
        sourceId: call.sourceId,
        status: call.status,
        errorCode: call.errorCode,
        startedAt: call.startedAt,
        finishedAt: call.finishedAt,
      };
      if (!result.toolAttempts.some((a) => same(a, expected)))
        throw new ResearchWebError('WEB_ATTEMPT_MISSING');
    }
    for (const call of result.toolAttempts.filter(
      (a) => a.toolName === 'WebSearch' || a.toolName === 'WebFetch',
    ))
      if (!calls.some((c) => c.id === call.id)) throw new ResearchWebError('WEB_ATTEMPT_FORGED');
  }
  async function close() {
    closed = true;
    for (const p of [...pending.values()]) p.abort();
    if (initialization) {
      await initialization;
      await writes;
    }
  }
  return {
    config: { ...config },
    bind,
    prepare,
    complete,
    failure,
    getSnapshot,
    resolveSource,
    getRecords,
    validateResultRecords,
    close,
  };
}
export type ResearchWebController = ReturnType<typeof createResearchWebController>;

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new ResearchWebError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
