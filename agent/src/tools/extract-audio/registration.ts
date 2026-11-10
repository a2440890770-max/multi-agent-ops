import { tool } from '@anthropic-ai/claude-agent-sdk';
import { ExtractAudioInputSchema, ExtractAudioResultSchema } from '@multi-agent-ops/shared';
import { createMediaRegistration, mediaCallSignal } from '../media-registration.js';
import { EXTRACT_AUDIO_TOOL_NAME } from '../names.js';
import type { createExtractAudioService } from './service.js';

export function createExtractAudioRegistration(
  service: ReturnType<typeof createExtractAudioService>,
) {
  return {
    toolName: EXTRACT_AUDIO_TOOL_NAME,
    ...createMediaRegistration({
      toolNames: [EXTRACT_AUDIO_TOOL_NAME],
      execution: service.execution,
      timeoutMs: service.config.timeoutMs,
      createTools: (sessionSignal) => [
        tool(
          'extract_audio',
          '从当前研究任务中已登记的视频提取整段默认音轨；无默认音轨时采用第一条。只传 videoAssetId，输出 16 kHz 单声道 PCM16 WAV 的 audioAssetId 及原视频时间偏移。不下载、不转写、不抽帧、不发布；不能指定路径、片段、音轨或命令参数。',
          ExtractAudioInputSchema.shape,
          async (args, extra) => {
            const result = ExtractAudioResultSchema.parse(
              await service.extract(args, {
                signal: mediaCallSignal(sessionSignal, extra),
              }),
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result,
              isError: result.status === 'failed',
            };
          },
          { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
        ),
      ],
    }),
  };
}

export type ExtractAudioRegistration = ReturnType<typeof createExtractAudioRegistration>;
