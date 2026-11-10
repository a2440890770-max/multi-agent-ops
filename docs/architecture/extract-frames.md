# extract_frames 工具

工具名为 `mcp__research_media__extract_frames`，与 `fetch_video`、`extract_audio`、`transcribe_audio` 共用 `research_media`。本模块提供共享 Zod 契约、受控本地 FFmpeg 处理和 SDK 注册入口。它取得研究视频的抽样画面，与最终发布抖音图文或视频无关。

工具仅抽取 PNG，不做 OCR、图像理解、图片生成或发布；输出 `analysisPerformed=false`。完整 Research、视频 Skill、图片读取/视觉模型、数据库执行器和页面尚未贯通，不能把工具注册等同于完成视觉分析。普通启动不抽帧，不调用模型。

## 输入

```json
{ "videoAssetId": "video_<资源标识>" }
```

可选参数二选一：`count`（均匀采样请求数量）或 `timestampsSeconds`（以选定视频流起点为零的时间点列表）。例如：

```json
{ "videoAssetId": "video_<资源标识>", "timestampsSeconds": [2.5, 12, 18.2] }
```

- 默认均匀请求 12 帧。均匀采样取各等分区间中点，即 `(i + 0.5) × 视频时长 / count`；单帧取视频中点。
- 每次请求数量默认上限 30，后端可配置。上限同时适用于 count 和指定时间点列表长度，重复时间点也计入请求数。超量明确拒绝，不截断。
- 时间必须有限且满足 `0 <= t < 视频资源时长`。非法、越界或混合采样参数明确拒绝，不擅自修正。
- 不接受 URL、本地路径、输出目录、帧率、滤镜、命令、任务身份或图片格式参数。任务/尝试/步骤/快照/研究授权从后端注入，视频从可信资源服务查找。

## 采样、图片和实际时间

1. 通过 `videoService.getAsset()` 检查当前任务、实时授权与视频文件完整性。
2. 选取非封面附件的默认视频轨道，无默认标记时取第一条实际视频轨道。读取起点与时间基准；缺失可靠信息时显式失败。
3. 流式扫描解码后的帧时间戳，仅保留每个请求的最近候选帧，内存不随视频总帧数增长。等距选较早帧。缺失、重复或倒序 PTS 不擅自重建时间轴。
4. 多个请求命中同一实际帧时只保存一次，保留全部请求到图片的映射。相同像素但不同来源时刻仍是不同采样帧，不靠像素相同擅自合并证据。
5. 批量提取所选解码帧。使用 `-copyts`、`-enc_time_base demux` 和 image2 的 `-frame_pts 1` 保留真实来源 PTS；从程序生成的 PTS 文件名核对结果，不从请求时间、平均帧率或不可信控制台文本推算实际时间。
6. 输出 PNG，长边最多 1920，保持显示比例且不放大。应用视频的标准直角旋转信息并转换为方形像素；未知的非直角旋转明确拒绝，不擅自裁剪。无裁剪、增强、文字识别或画面判断。
7. 每张图片检查 PNG 头、实际尺寸、旋转/比例/不放大要求，再通过 FFmpeg 完整解码并计算 SHA-256。只有通过检查的图片进入结果，未采用的图片清理。

`actualTimeSeconds = sourcePts × timeBaseNumerator / timeBaseDenominator - videoStartTimeSeconds`。同时保留原始 PTS、时间基准及视频流起点，便于核查。指定点不保证恰好存在对应帧，调用方应比较请求时间和实际时间，不得声称精确命中或完整观看了视频。

短视频或稀疏帧时间轴可能使多个请求命中同一帧，因此实际图片数可以少于请求数；成功解析所有请求时仍为 `succeeded`，附去重警告，不补造新图片。

## 输出和错误

共享契约位于 `shared/src/schemas/extract-frames.ts`：

- `succeeded`：所有采样请求均对应有效图片。
- `partial`：至少一张图片有效，且至少一个请求失败。返回成功图片、每个请求的对应关系或稳定失败码/说明，不以邻近其他图片冒充失败图片。
- `failed`：没有有效图片，或遇到授权失效、取消、整次超时、存储故障、轨道/时间轴无法核验等全局故障。不返回本次图片引用，清理本次目录。

有效结果包含 frameSetId、videoAssetId、sourceId、采样模式、请求数、视频轨道、时长、时间基准、frameAssetId、实际时间、尺寸/格式/大小/哈希、逐项请求结果、生成时间及复用标记。模型结果不含本地路径。

结果始终附 `SAMPLED_FRAMES_ONLY`；有重复命中时附 `DUPLICATE_FRAME_MATCHES`，部分缺口附 `PARTIAL_EXTRACTION`。若编码进程报告错误但部分 PNG 可独立验证，则附 `ENCODER_REPORTED_ERROR`。进程正常与否不替代逐张图片验证，也不把一个坏图片作为所有图片必然无效的依据。

有效 `partial` 在 MCP 中 `isError=false`，不会冒充完整成功，也不会因为存在缺口触发自动整次重跑。只有 `failed` 才标记协议工具错误。外部画面及其未来识别文字不改变权限、Skill 或人审要求。

## 执行、缓存和本地资源

- 总超时默认 600000 毫秒，覆盖实时授权、来源完整性、锁等待、帧扫描、提取、逐张校验及结果登记。主会话更早取消/超时仍终止子进程。
- 不增加视频时长/文件大小上限；输出帧数量和图片长边按已确认策略限制。长视频完整扫描可能超时，超时不交付本次半成品。
- 无 shell，使用参数数组、最小环境变量、固定输入解复用器和 `file,pipe` 协议白名单；不联网，不继承 Cookie、API 或数据库密钥。
- 不自动重试，不换下载器/模型或补采其他点。成功与有效 partial 文件暂不自动删除；失败/取消清理本次文件，不删之前的成功资源。清理/解锁失败显式报存储错误。
- 相同任务、视频内容/来源、采样点及图片规格通过文件锁串行执行，后来的调用等待并复用校验结果。等待者超时/取消不删除原调用的锁。原调用失败时等待者显式失败，不自动重跑；崩溃遗留锁需后续恢复机制或人工核查，不强行接管。
- 复用重新检查当前授权、来源完整性、结果及所有图片的大小和 SHA-256。partial 复用不会暗中重试失败点，Skill 若需补采，应在授权范围内显式请求失败时间点。
- 资源目录为 `<FETCH_VIDEO_ROOT>/<task哈希>/frames_<uuid>/`，含有效 `frame_<PTS>.png`、`result.json`、`manifest.json`。目录为 0700，图片和结构化文件为 0600；模型只收到资源标识。
- 有效图片集合通过校验并复查当前来源后才登记。磁盘不足或来源被撤销会整次失败，不保留本次 partial。

## SDK 接入

以下示例位于 `agent/src`，接在已有可信资源服务及完整 `researchIntegration` 之后；业务来源索引、实时授权、授权消耗与研究报告校验仍由接入方实现。

```ts
import {
  createExtractFramesService,
  createExtractFramesRegistration,
  createFetchVideoRegistration,
  createExtractAudioRegistration,
  createTranscribeAudioRegistration,
  readExtractFramesConfig,
  combineResearchMediaRegistrations,
  FETCH_VIDEO_TOOL_NAME,
  EXTRACT_AUDIO_TOOL_NAME,
  TRANSCRIBE_AUDIO_TOOL_NAME,
  EXTRACT_FRAMES_TOOL_NAME,
} from './index.js';

const frames = createExtractFramesService({
  execution: videoService.execution,
  config: readExtractFramesConfig(),
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
      TRANSCRIBE_AUDIO_TOOL_NAME,
      EXTRACT_FRAMES_TOOL_NAME,
    ],
  },
  mediaTools: combineResearchMediaRegistrations(
    createFetchVideoRegistration(videoService),
    createExtractAudioRegistration(audioService),
    createTranscribeAudioRegistration(transcriber),
    createExtractFramesRegistration(frames),
  ),
};
```

允许仅显式开放部分工具。声明与注册必须逐项匹配，不能通配授权。Supervisor 主 Agent 仍只能分派 Research；每次调用都受合法子 Agent 身份、`authorizeTool` 和资源服务实时授权检查约束。

`frames.getAsset(frameSetId, signal)` 返回后端校验后的集合；`frames.getFrameAsset(frameAssetId, signal)` 返回单张图片的后端文件引用及来源信息。两者均不注册为任意路径读取工具。后续视觉分析能力尚未接入，不提供图片给模型的隐藏通道。

## 配置与验证

| 环境变量                       | 默认值                                  | 说明                                 |
| ------------------------------ | --------------------------------------- | ------------------------------------ |
| `EXTRACT_FRAMES_FFMPEG_PATH`   | `FETCH_VIDEO_FFMPEG_PATH` 或 `ffmpeg`   | PATH 命令或绝对路径                  |
| `EXTRACT_FRAMES_FFPROBE_PATH`  | `FETCH_VIDEO_FFPROBE_PATH` 或 `ffprobe` | PATH 命令或绝对路径                  |
| `EXTRACT_FRAMES_TIMEOUT_MS`    | `600000`                                | 整次总超时                           |
| `EXTRACT_FRAMES_DEFAULT_COUNT` | `12`                                    | 默认均匀采样请求数，不能超过数量上限 |
| `EXTRACT_FRAMES_MAX_FRAMES`    | `30`                                    | 请求数量上限，后端可配置             |
| `EXTRACT_FRAMES_MAX_LONG_EDGE` | `1920`                                  | 允许降低，但不能超过首版 1920 的规格 |
| `FETCH_VIDEO_ROOT`             | `artifacts/media`                       | 与其他媒体工具共用资源根目录         |

本机使用 FFmpeg 8.1 验证；依赖较旧、缺少 `reset_sar` 或 demux 时间基准能力时会明确失败，不假定所有 FFmpeg 版本都兼容。未修改用户 `.env`，未调用付费模型。

本地自动测试覆盖输入限制、默认/指定时间点、去重与真实时间、partial/全部失败、源授权撤销、缓存篡改、全局取消/超时与清理、并发及等待者、MCP 四工具注册、Supervisor 权限。实际 FFmpeg 测试覆盖短视频、原图不放大、旋转矩阵、长边缩小、方形像素转换、可变帧率及非零来源 PTS 起点。

## 本批修改路径

```text
shared/src/schemas/extract-frames.ts
shared/src/index.ts
shared/tests/extract-frames.test.ts
agent/src/tools/extract-frames/config.ts
agent/src/tools/extract-frames/types.ts
agent/src/tools/extract-frames/sampling.ts
agent/src/tools/extract-frames/service.ts
agent/src/tools/extract-frames/registration.ts
agent/src/tools/extract-frames/index.ts
agent/src/tools/names.ts
agent/src/index.ts
agent/src/extract-frames.test.ts
agent/src/supervisor.test.ts
.env.example
README.md
docs/architecture/extract-frames.md
docs/architecture/supervisor.md
```
