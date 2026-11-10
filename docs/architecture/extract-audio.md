# extract_audio 工具

注册名：`mcp__research_media__extract_audio`。本模块实现共享契约、本地处理及受控 SDK 接入口；Research Agent、视频 Skill、数据库执行器与页面尚未贯通，普通启动不处理媒体或调用模型。

## 输入、输出与职责

模型只传 `{ videoAssetId }`，不能传路径、URL、时间段、音轨、FFmpeg 参数或执行标识。后端从 `fetch_video` 服务的 `getAsset()` 取得已登记资源，检查当前任务、来源授权及文件校验和。执行上下文固定在后端服务内，保留 task / attempt / step / inputSnapshot / authorization 标识。

共享 Schema 位于 `shared/src/schemas/extract-audio.ts`。成功结果包含：`audioAssetId`、`videoAssetId`、`sourceId`、`selectedAudioStreamIndex`、固定音频参数、实际时长和大小、`sourceTimeOffsetSeconds`、SHA-256、生成时间及复用标记；不含路径。失败结果包含 `videoAssetId`（无效输入时为 null）、错误码、脱敏说明及重试标记。

`sourceTimeOffsetSeconds` 是第一帧解码音频的时间戳减去视频流起点；后续转写时间加上该偏移，得到原视频播放时间。偏移可为负数，不能擅自改成零。若解码时间戳缺失、单次跳变或累计漂移超过 2 毫秒，或视频起点无法确定，则返回 `TIMELINE_UNAVAILABLE`。这是保守拒绝策略，不自动修补时间轴。

## 固定处理规则

- 首版只处理整段音轨。采用第一条标记为默认的音轨，否则采用第一条音轨，记录容器全局音轨索引；损坏时不尝试其他音轨。
- 输出 WAV / PCM signed 16-bit little-endian / 16000 Hz / 单声道，使用 `-rf64 auto`。不降噪、不裁切静音、不变速，不进行 ASR 或抽帧。
- 不限制媒体时长与大小。默认总超时 600000 毫秒，包括资源与授权读取、锁等待、逐帧解码检查、转换、输出完整解码、哈希及登记。主 SDK 会话更短的时限及人工取消仍然生效。
- 帧信息流式读取，不缓存完整逐帧列表；音频流式写盘，不把整个音频读入内存。选定音轨必须可完整解码，输出参数与解码时长必须匹配。静音音轨仍是有效音频；没有音轨返回 `NO_AUDIO`。
- 子进程使用参数数组、无 shell、最小环境变量和 `file,pipe` 协议白名单，并固定输入解复用器；禁止工具联网。模型及数据库密钥不传入 FFmpeg。
- 无自动重试。并发同任务、同视频内容与同策略参数通过文件锁串行化，后来的调用等待并复用成功结果；原调用失败时等待者显式失败，不自动重新执行。等待者超时或取消不删除其他调用的锁。
- 锁遗留时不按时间强行接管，等待至总超时，由后续恢复机制或人工核查。
- 成功音频暂不自动删除；复用及后端资源读取检查任务、实时授权、文件大小与 SHA-256。取消/失败清理本次文件，不删除既有成功资源；清理或解锁失败显式返回 `STORAGE_ERROR`。
- 完整校验、授权复查和 manifest/index 写入后才交付资源；磁盘不足显式报错，不返回半成品。资源目录共用 `FETCH_VIDEO_ROOT`，使用 `<task哈希>/audio_<uuid>/audio.wav` 和 manifest。

## SDK 接入

以下示例位于 `agent/src`，接在既有 `videoService` 和完整的 `researchIntegration` 之后。它们分别负责可信来源索引、实时授权、研究授权消耗与研究结果校验，本工具不提供模拟实现。

```ts
import {
  combineResearchMediaRegistrations,
  createFetchVideoRegistration,
  createExtractAudioRegistration,
  createExtractAudioService,
  readExtractAudioConfig,
  FETCH_VIDEO_TOOL_NAME,
  EXTRACT_AUDIO_TOOL_NAME,
} from './index.js';

const audioService = createExtractAudioService({
  execution: videoService.execution,
  config: readExtractAudioConfig(),
  videoService,
});

const research = {
  ...researchIntegration,
  definition: {
    ...researchIntegration.definition,
    tools: [
      ...researchIntegration.definition.tools,
      FETCH_VIDEO_TOOL_NAME,
      EXTRACT_AUDIO_TOOL_NAME,
    ],
  },
  mediaTools: combineResearchMediaRegistrations(
    createFetchVideoRegistration(videoService),
    createExtractAudioRegistration(audioService),
  ),
};
```

也可以只显式注册 `extract_audio`，但仍须提供可信的视频资源服务。声明和注册必须逐项匹配，不支持通配开放。Supervisor 主 Agent 仍只能分派 Research，不能直接使用媒体工具；每次调用同时受子 Agent 身份检查、`authorizeTool` 及资源服务授权检查约束。Skill 不会自动获得命令执行权限。

已实现的 [transcribe_audio](transcribe-audio.md) 通过后端 `audioService.getAsset(audioAssetId, signal)` 取得经过校验的路径；它与现有两个媒体工具组合注册，不能给模型暴露通用路径读取接口。

## 配置

| 变量                         | 默认值                                  | 说明                     |
| ---------------------------- | --------------------------------------- | ------------------------ |
| `EXTRACT_AUDIO_FFMPEG_PATH`  | `FETCH_VIDEO_FFMPEG_PATH` 或 `ffmpeg`   | PATH 命令名或绝对路径    |
| `EXTRACT_AUDIO_FFPROBE_PATH` | `FETCH_VIDEO_FFPROBE_PATH` 或 `ffprobe` | PATH 命令名或绝对路径    |
| `EXTRACT_AUDIO_TIMEOUT_MS`   | `600000`                                | 整次调用超时，包括等待   |
| `FETCH_VIDEO_ROOT`           | `artifacts/media`                       | 与视频服务共用资源根目录 |

只更新 `.env.example`；不改用户 `.env` 或读取其中密钥。

## 验证与范围

本地测试覆盖输入注入拒绝、默认音轨/第一音轨、偏移映射、缺少音轨/不连续时间戳/损坏与不完整输出、缓存篡改、授权撤销、并发复用、超时取消及清理、MCP tools/list/call、Supervisor 身份与逐项注册校验。安装 FFmpeg 的本机还运行真实静音视频提取与完整解码，静音不会误报失败。

本机此前已验证 FFmpeg 8.1 与 whisper.cpp 1.9.5 的普通 WAV 和短音频强制 RF64 兼容；尚未验证超过 4 GiB 文件及超长音频的下游内存表现。不将未验证情况视为兼容保证。

## 本批源码与文档路径

```text
shared/src/schemas/extract-audio.ts
shared/src/index.ts
shared/tests/extract-audio.test.ts
agent/src/tools/extract-audio/config.ts
agent/src/tools/extract-audio/types.ts
agent/src/tools/extract-audio/service.ts
agent/src/tools/extract-audio/registration.ts
agent/src/tools/extract-audio/index.ts
agent/src/tools/media-registration.ts
agent/src/tools/names.ts
agent/src/tools/fetch-video/types.ts
agent/src/tools/fetch-video/process.ts
agent/src/tools/fetch-video/registration.ts
agent/src/agents/supervisor/types.ts
agent/src/agents/supervisor/runtime.ts
agent/src/index.ts
agent/src/extract-audio.test.ts
agent/src/supervisor.test.ts
.env.example
README.md
docs/architecture/extract-audio.md
docs/architecture/fetch-video.md
docs/architecture/supervisor.md
```
