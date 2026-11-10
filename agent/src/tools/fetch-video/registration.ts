import { tool } from '@anthropic-ai/claude-agent-sdk';
import { FetchVideoInputSchema, FetchVideoResultSchema } from '@multi-agent-ops/shared';
import { FETCH_VIDEO_TOOL_NAME } from '../names.js';
import { createMediaRegistration, mediaCallSignal } from '../media-registration.js';
import type { createFetchVideoService } from './service.js';

export function createFetchVideoRegistration(service: ReturnType<typeof createFetchVideoService>) {
  return {
    toolName: FETCH_VIDEO_TOOL_NAME,
    ...createMediaRegistration({
      toolNames: [FETCH_VIDEO_TOOL_NAME],
      execution: service.execution,
      timeoutMs: service.config.timeoutMs,
      createTools(sessionSignal) {
        return [
          tool(
            'fetch_video',
            '获取当前研究任务中已登记的视频来源。只传 sourceId；后端决定站点、Chrome 会话、目录和下载策略。返回可供后续媒体工具使用的 videoAssetId。该工具不转写、抽帧或发布内容。',
            FetchVideoInputSchema.shape,
            async (args, extra) => {
              const signal = mediaCallSignal(sessionSignal, extra);
              const result = FetchVideoResultSchema.parse(await service.fetch(args, { signal }));
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                structuredContent: result,
                isError: result.status === 'failed',
              };
            },
            { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
          ),
        ];
      },
    }),
  };
}

export type FetchVideoRegistration = ReturnType<typeof createFetchVideoRegistration>;
