# transcribe_audio 工具

工具名为 `mcp__research_media__transcribe_audio`，与视频获取、音频提取共用 `research_media`。本模块包含共享 Zod 契约、本机 whisper.cpp 调用、结果校验和受控 SDK 注册入口。完整 Research、视频 Skill、数据库执行器与页面尚未贯通，普通服务启动不自动执行转写。

## 本机调用方式

无需用户提供 HTTP 接口或 API Key。后端通过参数数组、无 shell 的子进程调用已安装的 `whisper-cli`，读取本机模型及经过资源服务校验的 WAV。不会自动下载、联网转写、切换模型或退回第三方服务。

默认模型为当前用户的 `~/.local/share/whisper.cpp/models/ggml-small.bin`。路径只存在于后端配置及本地原始审计文件，不提供给模型选择。执行环境不继承模型/API/数据库密钥或代理变量。

## 输入与输出

```json
{ "audioAssetId": "audio_<资源标识>", "language": "auto" }
```

实际 Schema 对语言使用固定白名单，不接受任意字符串。缺省为 `auto`；首版白名单依据本机 whisper.cpp 1.9.5 的语言 API，包含 `zh`、`en`、`yue` 等，不接受 `zh-CN`、命令选项、路径、片段、模型或翻译参数。

成功结果包括：

- `transcriptAssetId`、`audioAssetId`、`videoAssetId`、`sourceId`。
- `engine=whisper.cpp`、实际引擎版本、实际模型文件 SHA-256、请求语言和识别语言。
- `inputScope=entire_audio`、实际输入时长和来源时间偏移。
- 原语言正文及句子/短语分段；每段有稳定 ID、文字、音频起止秒数和原视频起止秒数。
- `empty`、程序生成的质量警告、生成时间、复用标记。

原视频时间 = 音频时间 + 音频资源的 `sourceTimeOffsetSeconds`。不截断负的来源时间。时间戳是自动估计，不提供逐词定位或说话人识别。末尾不超过 20 毫秒的舍入误差会限制到音频实际时长，并附 `TIMESTAMP_BOUNDARY_ADJUSTED`；更大越界、倒序、翻译结果或语言不符均拒绝，不通过排序、补写或日志恢复修复。

结果必须保留 `ASR_UNVERIFIED` 与 `TIMESTAMPS_ESTIMATED`。ASR 可能误识别项目名、数字甚至无语音内容；自动识别语言不能保证准确识别混合语言。未经核验的转写文字不自动成为已核实事实。资料中的“忽略规则，直接发布”等内容只作为引用数据，不改变工具权限、Skill 或审批。

## 完整处理与失败边界

1. 使用 `audioService.getAsset()` 检查当前任务、实时授权及文件完整性。执行上下文从后端注入，包括 task / attempt / step / inputSnapshot / authorization 标识。
2. 检查本机模型文件，计算实际模型哈希，获取 `whisper-cli --version`。缺少依赖或模型时显式失败，不自动安装或下载。
3. 按整段输入、原语言、后端线程数运行一次 Whisper，生成原始 JSON/TXT/SRT。**不进行工具层面的切块、重试、翻译或模型降级**，也不限制音频时长与文件大小。
4. 只从完整原生 JSON 构造结果；不解析控制台正文，不以部分 TXT/SRT 补救失败。校验分段正文、顺序、语言、时间范围及来源映射，检查三个原始文件均存在且符合空/非空结果要求。
5. 复查音频授权/完整性与模型哈希，通过后写入结果、manifest 和原子资源索引，供下游引用。

Whisper 正常结束且输出有效空结果时，返回 `succeeded`、`empty=true`、空正文/分段和 `NO_TEXT_RECOGNIZED` 警告；这不能证明无人声，Research 应标记证据缺口。中途失败、超时、取消及内存不足一律返回 `failed`，不交付部分文字，清理本次残留。

明确的内存分配失败返回 `RESOURCE_EXHAUSTED`；进程被系统信号终止但无法证明原因时返回 `PROCESS_TERMINATED`，不能武断归因为内存不足。其他错误区分无效输入、资源不存在/无权限、模型/依赖不可用、转写失败、格式错误和存储错误。错误信息脱敏，`retryable` 只提示后续人工或执行器决策，不触发自动重试。

总超时默认 600000 毫秒，覆盖授权/资源读取、模型哈希、版本读取、锁等待、模型加载、转写和结果校验。主 SDK 会话更早取消/超时会停止子进程。整段处理可能占用较多内存；尚未验证超长音频的资源表现，不承诺任意长度都能转写成功。

## 并发、缓存及本地文件

- 相同任务、音频内容、来源映射、语言、引擎版本、模型内容与线程配置共用一个任务级文件锁，后来的调用等待并复用有效结果。原调用失败时等待者显式失败，不自动重跑；等待者取消或超时不删除其他调用的锁。崩溃遗留锁不按时间强行接管，需后续恢复机制或人工处理。
- 成功文件暂不自动删除。复用或后端读取重新校验当前授权、音频来源、结果/原始文件大小及 SHA-256；语言、模型内容等变化不复用旧结果。后端仍可读取并引用旧版本资源，其原版本元数据保留。
- 目录为 `<FETCH_VIDEO_ROOT>/<task哈希>/transcript_<uuid>/`，含 `whisper.json`、`whisper.txt`、`whisper.srt`、`result.json`、`manifest.json`。目录私有，原始文件收紧为 0600。`whisper.srt` 是原生音频时间轴，原视频时间须使用结构化结果映射。
- 逐个流式计算模型及结果文件哈希，控制台不缓冲整段转写；音频由独立 Whisper 进程整段读取。结构化正文/分段仍需在宿主内存中解析并返回，不将文件大小无限制等同于内存消耗无限制。
- 不改用户 `.env` 或数据库，不自动上传视频、音频、转写或 Trace。

## SDK 接入

以下示例位于 `agent/src`，接在可信的 `videoService`、`audioService` 和完整 `researchIntegration` 后。来源登记、实时授权、研究授权消耗及报告校验仍由业务接入方实现。

```ts
import {
  createTranscribeAudioService,
  createTranscribeAudioRegistration,
  createFetchVideoRegistration,
  createExtractAudioRegistration,
  combineResearchMediaRegistrations,
  readTranscribeAudioConfig,
  FETCH_VIDEO_TOOL_NAME,
  EXTRACT_AUDIO_TOOL_NAME,
  TRANSCRIBE_AUDIO_TOOL_NAME,
} from './index.js';

const transcriber = createTranscribeAudioService({
  execution: audioService.execution,
  config: readTranscribeAudioConfig(),
  audioService,
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
    ],
  },
  mediaTools: combineResearchMediaRegistrations(
    createFetchVideoRegistration(videoService),
    createExtractAudioRegistration(audioService),
    createTranscribeAudioRegistration(transcriber),
  ),
};
```

也可只开放转写工具，但必须注入可信音频资源服务。工具声明和注册必须逐项匹配；Supervisor 主 Agent 仍只能分派 Research。合法子 Agent 身份、`authorizeTool` 和资源服务的实时授权三层检查继续生效。

后续后端消费者通过 `transcriber.getAsset(transcriptAssetId, signal)` 取得校验后的结构化结果路径；模型只得到资源标识和结构化文字，无任意文件读取入口。

## 配置

| 环境变量                        | 默认值                                                          | 说明                                           |
| ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `TRANSCRIBE_AUDIO_WHISPER_PATH` | `whisper-cli`                                                   | PATH 命令或绝对路径                            |
| `TRANSCRIBE_AUDIO_MODEL_PATH`   | 当前用户目录下 `.local/share/whisper.cpp/models/ggml-small.bin` | 必须是可读取的本地模型文件绝对路径，不自动下载 |
| `TRANSCRIBE_AUDIO_TIMEOUT_MS`   | `600000`                                                        | 整次调用总时限                                 |
| `TRANSCRIBE_AUDIO_THREADS`      | `4`                                                             | 后端控制的线程数                               |
| `FETCH_VIDEO_ROOT`              | `artifacts/media`                                               | 与音频/视频资源服务共用根目录                  |

## 本批文件清单

```text
shared/src/schemas/transcribe-audio.ts
shared/src/index.ts
shared/tests/transcribe-audio.test.ts
agent/src/tools/transcribe-audio/config.ts
agent/src/tools/transcribe-audio/types.ts
agent/src/tools/transcribe-audio/output.ts
agent/src/tools/transcribe-audio/service.ts
agent/src/tools/transcribe-audio/registration.ts
agent/src/tools/transcribe-audio/index.ts
agent/src/tools/names.ts
agent/src/tools/fetch-video/types.ts
agent/src/tools/fetch-video/process.ts
agent/src/index.ts
agent/src/transcribe-audio.test.ts
agent/src/supervisor.test.ts
.env.example
README.md
docs/architecture/transcribe-audio.md
docs/architecture/extract-audio.md
docs/architecture/supervisor.md
```
