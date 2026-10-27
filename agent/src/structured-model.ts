import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDeepSeekOptions, readDeepSeekConfig } from './model-config.js';
import type { ModelRole } from './model-config.js';

export function validateStructuredResult<T extends z.ZodType>(
  result: Pick<SDKResultMessage, 'subtype' | 'is_error'> & { structured_output?: unknown },
  schema: T,
): z.output<T> {
  if (result.subtype !== 'success' || result.is_error) {
    throw new Error(`SDK 调用失败：${result.subtype}；未采用模型输出。`);
  }
  if (result.structured_output === undefined) {
    throw new Error('SDK 没有返回 structured_output；普通文本或 JSON 文本不能替代结构化结果。');
  }
  const parsed = schema.safeParse(result.structured_output);
  if (!parsed.success) {
    // Report paths and issue codes only, never the rejected content.
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`);
    throw new Error(`结构化输出校验失败：${issues.join(', ')}。`);
  }
  return parsed.data;
}

export type ModelRunMetadata = {
  model: string;
  sessionId: string | null;
  initializedModel: string | null;
  resultSubtype: string | null;
  resultIsError: boolean | null;
  apiErrorStatus: number | null;
  turns: number | null;
  structuredToolCalls: number;
  sdkReportedModelNames: string[];
};

export async function queryDeepSeekStructured<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options: {
    role?: ModelRole;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onMetadata?: (metadata: ModelRunMetadata) => void;
  } = {},
): Promise<{ data: z.output<T>; metadata: ModelRunMetadata }> {
  const runtimeEnv = options.env ?? process.env;
  const config = readDeepSeekConfig(runtimeEnv);
  const sdkOptions = createDeepSeekOptions(config, options.role, runtimeEnv);
  const timeoutMs = options.timeoutMs ?? 50000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('模型超时必须为 1000—60000 毫秒。');
  }
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' });
  const directory = await mkdtemp(join(tmpdir(), 'multi-agent-ops-model-'));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const metadata: ModelRunMetadata = {
    model: sdkOptions.model!,
    sessionId: null,
    initializedModel: null,
    resultSubtype: null,
    resultIsError: null,
    apiErrorStatus: null,
    turns: null,
    structuredToolCalls: 0,
    sdkReportedModelNames: [],
  };
  let session: ReturnType<typeof query> | undefined;
  let data: z.output<T> | undefined;
  let received = false;
  try {
    session = query({
      prompt,
      options: {
        ...sdkOptions,
        cwd: directory,
        env: { ...sdkOptions.env, CLAUDE_CONFIG_DIR: join(directory, 'config') },
        systemPrompt: 'Follow the requested schema and return your answer using StructuredOutput.',
        outputFormat: { type: 'json_schema', schema: jsonSchema },
        allowedTools: ['StructuredOutput'],
        maxTurns: 4,
        maxBudgetUsd: 0.1,
        abortController,
        // The CLI can log provider responses. Do not forward raw stderr into logs.
        stderr: () => {},
      },
    });
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init') {
        metadata.sessionId = message.session_id;
        metadata.initializedModel = message.model;
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue;
          if (block.name !== 'StructuredOutput') throw new Error('模型请求了本次未开放的工具。');
          metadata.structuredToolCalls += 1;
        }
      }
      if (message.type !== 'result') continue;
      metadata.resultSubtype = message.subtype;
      metadata.resultIsError = message.is_error;
      metadata.apiErrorStatus =
        'api_error_status' in message ? (message.api_error_status ?? null) : null;
      metadata.turns = message.num_turns;
      metadata.sdkReportedModelNames = Object.keys(message.modelUsage ?? {});
      data = validateStructuredResult(message, schema);
      received = true;
    }
    if (!received) throw new Error('SDK 结束但没有返回有效的结构化结果。');
    return { data: data as z.output<T>, metadata };
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('SDK 结构化调用超时；未验收通过。', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    session?.close();
    await rm(directory, { recursive: true, force: true });
    options.onMetadata?.({ ...metadata });
  }
}
