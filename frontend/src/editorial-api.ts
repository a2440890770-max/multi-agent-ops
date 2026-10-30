import type { ApiSuccess, ResponseModels } from '@multi-agent-ops/shared';
import { request } from './task-api.js';

export function editorialRequest<K extends keyof ResponseModels>(
  path: string,
  model: K,
  options: {
    body?: unknown;
    key?: string;
    csrf?: string;
    method?: 'POST' | 'PUT';
    successStatus?: number | number[];
    signal?: AbortSignal;
  } = {},
) {
  return request(path, options, (value): value is ResponseModels[K] => {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (['ContentVersions', 'Reviews', 'Decisions'].includes(model))
      return Array.isArray(v.items) && (v.nextCursor === null || typeof v.nextCursor === 'string');
    if (model === 'SaveContent') return !!v.task && !!v.content;
    if (model === 'ApprovalResult') return !!v.task && !!v.approval;
    if (model === 'Decision') return !!v.task && !!v.decision;
    if (model === 'CompareVersions') return !!v.from && !!v.to && Array.isArray(v.changes);
    return typeof v.id === 'string' || (model === 'Config' && Number.isSafeInteger(v.version));
  });
}

export async function allEditorialPages<K extends 'ContentVersions' | 'Reviews' | 'Decisions'>(
  path: string,
  model: K,
  signal: AbortSignal,
) {
  let cursor: string | null = null;
  const items: ResponseModels[K]['items'][number][] = [];
  do {
    const result: ApiSuccess<ResponseModels[K]> = await editorialRequest(
      path + '?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
      model,
      { signal },
    );
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
  } while (cursor);
  return items as ResponseModels[K]['items'];
}
