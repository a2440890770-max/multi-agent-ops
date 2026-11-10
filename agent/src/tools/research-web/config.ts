import { resolve } from 'node:path';
import { ResearchWebConfigSchema, type ResearchWebConfig } from '@multi-agent-ops/shared';

export function readResearchWebConfig(env: NodeJS.ProcessEnv = process.env): ResearchWebConfig {
  const number = (name: string, fallback: number) =>
    env[name]?.trim() ? Number(env[name]) : fallback;
  return ResearchWebConfigSchema.parse({
    root: resolve(env.RESEARCH_WEB_ROOT?.trim() || 'artifacts/research'),
    maxSearchCalls: number('RESEARCH_WEB_MAX_SEARCH_CALLS', 12),
    maxFetchCalls: number('RESEARCH_WEB_MAX_FETCH_CALLS', 10),
    maxSearchResults: number('RESEARCH_WEB_MAX_SEARCH_RESULTS', 10),
    timeoutMs: number('RESEARCH_WEB_TIMEOUT_MS', 60000),
    maxResponseBytes: number('RESEARCH_WEB_MAX_RESPONSE_BYTES', 10 * 1024 * 1024),
    maxTextCharacters: number('RESEARCH_WEB_MAX_TEXT_CHARACTERS', 50000),
    maxRedirects: number('RESEARCH_WEB_MAX_REDIRECTS', 5),
  });
}

export class ResearchWebError extends Error {
  constructor(readonly code: string) {
    super(`Research 网页工具失败：${code}`);
  }
}
