import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SEARCH_TOOLS = ['WebSearch', 'WebFetch'];
export const searchAnswerSchema = z.strictObject({
  status: z.enum(['ok', 'failed']),
  summary: z.string().min(1),
  anthropicBaseUrl: z.string(),
  models: z.array(z.string()),
  sources: z
    .array(
      z.strictObject({ title: z.string().min(1), url: z.url(), supportingText: z.string().min(1) }),
    )
    .max(3),
});
export type SearchAnswer = z.infer<typeof searchAnswerSchema>;
export type SearchHit = { title: string; url: string; snippet: string };
export type SearchCall = {
  id: string;
  query: string;
  status: 'pending' | 'denied' | 'failed' | 'completed';
  hits: SearchHit[];
  error?: string;
};
export type SearchEvidence = {
  searches: SearchCall[];
  fetches: {
    id: string;
    url: string;
    status: 'requested' | 'completed' | 'failed';
    code?: number;
  }[];
  deniedTools: { name: string; reason: string }[];
};

// Compare rendered text: WebFetch returns Markdown while the independent reader
// receives HTML. Formatting markers are not part of the quoted words.
export function normalizeSourceText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, '')
    .normalize('NFKC');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function officialSourceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api-docs.deepseek.com' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('本次验证只读取 DeepSeek 官方公开文档域名。');
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

export function extractSearchHits(value: unknown): SearchHit[] {
  const output = record(value);
  if (!Array.isArray(output.results)) return [];
  const hits: SearchHit[] = [];
  for (const group of output.results) {
    const content = record(group).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const hit = record(item);
      if (typeof hit.title !== 'string' || typeof hit.url !== 'string') continue;
      try {
        hits.push({
          title: hit.title,
          url: officialSourceUrl(hit.url),
          snippet: typeof hit.snippet === 'string' ? hit.snippet.slice(0, 400) : '',
        });
      } catch {
        /* Ignore non-official search hits, never treat them as verified sources. */
      }
    }
  }
  return hits;
}

export function readOnlyDecision(
  name: string,
  input: unknown,
  evidence: SearchEvidence,
  denySearch: boolean,
): string | null {
  if (name === 'StructuredOutput') return null;
  if (name === 'WebSearch') return denySearch ? '本次负向测试禁止搜索，不能用记忆替代。' : null;
  if (name === 'WebFetch') {
    try {
      const url = officialSourceUrl(String(record(input).url ?? ''));
      if (
        evidence.searches.some(
          (call) => call.status === 'completed' && call.hits.some((hit) => hit.url === url),
        )
      )
        return null;
    } catch {
      /* Return a generic policy reason without echoing the rejected URL. */
    }
    return '只读取本次成功搜索实际返回的官方来源。';
  }
  return '本次仅开放只读搜索、网页读取和 SDK 结构化输出。';
}

export function createSearchHooks(evidence: SearchEvidence, denySearch: boolean): Options['hooks'] {
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const reason = readOnlyDecision(input.tool_name, input.tool_input, evidence, denySearch);
    if (input.tool_name === 'WebSearch') {
      evidence.searches.push({
        id: input.tool_use_id,
        query: String(record(input.tool_input).query ?? '').slice(0, 300),
        status: reason ? 'denied' : 'pending',
        hits: [],
      });
    }
    if (reason) {
      evidence.deniedTools.push({ name: input.tool_name, reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    if (input.tool_name === 'WebFetch')
      evidence.fetches.push({
        id: input.tool_use_id,
        url: officialSourceUrl(String(record(input.tool_input).url)),
        status: 'requested',
      });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        ...(input.tool_name === 'WebSearch'
          ? {
              updatedInput: {
                ...record(input.tool_input),
                allowed_domains: ['api-docs.deepseek.com'],
              },
            }
          : {}),
      },
    };
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    if (input.tool_name === 'WebSearch') {
      const call = evidence.searches.find((item) => item.id === input.tool_use_id);
      if (call) {
        call.hits = extractSearchHits(input.tool_response);
        call.status = call.hits.length ? 'completed' : 'failed';
      }
    }
    if (input.tool_name === 'WebFetch') {
      const call = evidence.fetches.find((item) => item.id === input.tool_use_id);
      const code = record(input.tool_response).code;
      if (call) {
        if (typeof code === 'number') call.code = code;
        call.status = code === 200 ? 'completed' : 'failed';
      }
    }
    return {};
  };
  const failure: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUseFailure') return {};
    const search = evidence.searches.find((item) => item.id === input.tool_use_id);
    if (search) {
      search.status = 'failed';
      search.error = 'SDK search tool failed; raw provider error omitted.';
    }
    const fetch = evidence.fetches.find((item) => item.id === input.tool_use_id);
    if (fetch) fetch.status = 'failed';
    return {};
  };
  return {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUse: [{ hooks: [post] }],
    PostToolUseFailure: [{ hooks: [failure] }],
  };
}

export function assertSearchEvidence(answer: SearchAnswer, evidence: SearchEvidence): void {
  const successful = evidence.searches.filter(
    (call) => call.status === 'completed' && call.hits.length > 0,
  );
  if (!successful.length) throw new Error('没有真实成功的搜索工具结果，不能验收通过。');
  if (answer.status !== 'ok' || !answer.sources.length) throw new Error('搜索结果没有可验证来源。');
  const urls = new Set(successful.flatMap((call) => call.hits.map((hit) => hit.url)));
  for (const source of answer.sources) {
    if (!urls.has(officialSourceUrl(source.url)))
      throw new Error('模型引用了本次搜索工具没有返回的链接。');
  }
}
