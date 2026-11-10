# fetch_video 工具

本批实现 Research 的受控视频获取工具及原生 SDK MCP 注册接入口。Research Agent、两个研究 Skill、任务数据库执行器和页面尚未接入；不能将工具注册视为研究业务已贯通。普通服务启动不下载视频、不读取 Chrome、不调用模型，健康检查仍为 `canExecuteTasks=false`。

## 已确认的契约

- 模型输入只允许 `{ sourceId }`。URL 从后端的当前任务来源索引中取得，保留小红书完整分享参数；模型不能提供路径、Cookie、浏览器配置、命令或额外参数。
- 首版支持 B 站和小红书；抖音返回 `PLATFORM_NOT_ENABLED`，留给 Research 报告缺口。
- 使用本地 yt-dlp 获取单条已录制视频，优先 MP4 和带声音格式。720p 以短边计，兼容 `1280×720` 与 `720×1280`；没有适合的格式时明确失败，不偷偷下载超出画质的版本。
- 不限制视频时长和文件大小；工具总超时默认 600000 毫秒，包含来源/授权读取、Cookie 读取、元数据解析、下载、FFprobe、完整 FFmpeg 解码与哈希校验。主会话更短的超时或人工取消仍会终止工具。
- 小红书在实际下载时从后端配置的 Chrome 用户配置读取 Cookie，本机先用 `Default`；B 站首版不读取 Cookie。认证失败提示用户在浏览器完成登录/验证后手动重试，不自动登录、刷新凭据或切换配置。
- yt-dlp 自身重试设为 0，403/认证失败返回 `retryable=false`。临时网络错误仅标记可重试，由后续执行器按任务配置决定，不在工具中自动多次抓取。
- 成功文件先保留，不自动按天数删除。同任务、同来源链接和同画质配置可复用；复用前核对授权、文件大小和 SHA-256。重复并发请求显式返回 `RESOURCE_BUSY`。
- 取消和失败清理本次临时文件，不删除以前成功的资源；清理失败返回存储错误。进程崩溃后遗留的锁需由后续恢复机制核查，本批不按时间强行解锁。

成功结果包含 `videoAssetId`、`sourceId`、平台、时长、大小、宽高、容器、音轨标记、SHA-256、获取时间及复用标记。失败结果包含稳定错误码、可展示说明及重试标记。共享 Zod Schema 位于 `shared/src/schemas/fetch-video.ts`，模型结果中不包含本地文件路径、完整 URL 或 Cookie。

## 后端接入

注册名称为 `mcp__research_media__fetch_video`，服务器键为 `research_media`。在构造 ResearchIntegration 时显式加入工具名和注册对象：

```ts
import {
  createFetchVideoRegistration,
  createFetchVideoService,
  FETCH_VIDEO_TOOL_NAME,
  readFetchVideoConfig,
} from './tools/fetch-video/index.js';

const service = createFetchVideoService({
  config: readFetchVideoConfig(),
  execution: {
    ...context.execution,
    authorizationId: context.researchContext.authorizationId!,
  },
  // 必须来自后端登记记录，包含 sourceId、taskId、authorizationId 和完整 url。
  resolveSource: (sourceId, signal) => sourceRegistry.find(sourceId, signal),
  // 必须查询当前有效状态；不能把旧快照或模型传入的状态作为授权。
  authorize: ({ execution, source, signal }) =>
    authorizationStore.canReadSource(execution, source, signal),
});

const mediaTools = createFetchVideoRegistration(service);
const research = {
  // 保留已有 version、definition、claimAuthorization、authorizeTool、acceptResult。
  ...researchIntegration,
  definition: {
    ...researchIntegration.definition,
    tools: [...researchIntegration.definition.tools, FETCH_VIDEO_TOOL_NAME],
  },
  mediaTools,
};
```

上例中的来源索引、实时授权存储和完整 ResearchIntegration 是后续业务适配点，本批不提供模拟业务实现。`sourceId` 存在不等于允许访问；服务会核对任务和授权归属，并在复用及接收新资源前重新检查。

`runSupervisor()` 为本次会话创建 SDK MCP server，并将取消信号传给工具；注册服务必须绑定相同任务、尝试、输入快照和研究授权。主 Agent 仍仅拥有 `Agent`；Research 的工具声明及每次权限 hook 都必须允许该工具，不开放通配 MCP、Bash 或通用发布权限。必需的视频 Skill 将在 Research 实现时单独加载，本批不自动加载任何 Skill。

已实现的 [extract_audio](extract-audio.md) 通过 `service.getAsset(videoAssetId, signal)` 取得经过任务/授权/完整性校验的文件引用；两个工具使用 `combineResearchMediaRegistrations()` 组合注册，不能用第二个同名服务器覆盖第一个。不得将任意文件路径读取能力交给模型，该接口不注册成通用 `Read` 工具。

## 配置与本地资源

变量在 `.env.example` 中，当前不修改用户 `.env`：

| 变量                         | 默认值            | 说明                                                               |
| ---------------------------- | ----------------- | ------------------------------------------------------------------ |
| `FETCH_VIDEO_YTDLP_PATH`     | `yt-dlp`          | 命令名或绝对路径；本机安装在 `/Users/liutingfei/.local/bin/yt-dlp` |
| `FETCH_VIDEO_FFMPEG_PATH`    | `ffmpeg`          | PATH 中的 ffmpeg 或绝对路径；绝对路径也传给 yt-dlp 合并器          |
| `FETCH_VIDEO_FFPROBE_PATH`   | `ffprobe`         | 媒体校验依赖                                                       |
| `FETCH_VIDEO_ROOT`           | `artifacts/media` | 相对仓库根目录解析；不使用模型给出的目录                           |
| `FETCH_VIDEO_CHROME_PROFILE` | `Default`         | 支持 `Default` / `Profile N`，仅由后端配置                         |
| `FETCH_VIDEO_TIMEOUT_MS`     | `600000`          | 单次工具调用的总超时                                               |
| `FETCH_VIDEO_MAX_RESOLUTION` | `720`             | 视频短边上限                                                       |

文件保存在 `artifacts/media/<任务哈希>/video_<UUID>/`，成功后只保留媒体和资源清单。清单关联原始 task/attempt/step/inputSnapshot/authorization 标识，资源 ID 由后端生成；来源参数只保存不可逆摘要，不将带 token 的分享链接写入清单。媒体目录已加入 Git 忽略。

Cookie 原值不写入清单、模型上下文、日志或工具结果。yt-dlp 自身读取 Chrome 时可能读取整个所选用户配置的 Cookie 数据库，后续可配置专用研究配置；它的临时文件被定向到任务私有目录并清理。会话过期或平台拒绝请求不代表工具可以改用其他配置或绕过验证。

## 访问与进程边界

- yt-dlp 使用参数数组启动，不经过 shell；忽略用户配置、插件和缓存，不继承数据库/模型密钥或外部代理设置。
- 来源只接受标准 HTTPS 平台链接；不接受 URL 内嵌凭据和自定义端口。
- 每次调用建立本地代理，所有 yt-dlp HTTPS 请求和重定向都经过同一平台及 CDN 主机范围检查。DNS 仅解析 IPv4，拒绝私网、回环、链路本地等地址，并连接已校验的地址，避免 DNS 检查后重新解析。
- B 站允许 `bilibili.com`、`b23.tv`、`bilivideo.com/.cn/.net`、`hdslb.com`；小红书允许 `xiaohongshu.com`、`xhslink.com`、`xhscdn.com` 及各自子域。新增域名需改后端策略；不根据网页指令自动放开。
- 首版采用可解析出的 HTTPS 直链 MP4/M4A/WebM 格式；不将 HLS、直播、播放列表或任意外部网站默认为已支持。
- 原始元数据不直接用于重新执行：只投影必要的格式字段和受限 HTTP headers，移除路径、额外处理器、Cookie、Authorization 等字段，临时元数据用完即删。
- FFmpeg 合并、FFprobe 和完整解码只允许本地文件/管道协议。取消或超时终止进程组，并清理本次残留。
- 元数据 stdout 缓冲上限 4 MiB，stderr 64 KiB；这是程序消息缓冲限制，不是视频大小或 RAM 配额。视频始终落本地文件，不放入模型或数据库二进制字段。

## 验证范围

自动测试使用明确标注的离线进程夹具和 SDK MCP 协议，覆盖输入注入、来源/任务/授权归属、媒体校验、缺音轨、取消、超时、清理、复用哈希、防并发及 SDK 身份限制，不发起模型付费请求或读取真实 Chrome Cookie。

本机 yt-dlp 的参数与格式选择另使用 `.invalid` 地址和 `--simulate --no-check-formats` 做离线检查。此前独立测试曾成功下载 B 站样例及用户提供的小红书视频；新封装中的受控代理、资源索引和完整工具调用仍需后续真实来源联调，不能把此前下载结果当作本模块联网验收。

## 本批修改路径

以下路径均相对仓库根目录 `/Users/liutingfei/Documents/Codex/projects/multi-agent-ops/`，不包含之前已有的其他未提交改动：

```text
shared/src/schemas/fetch-video.ts
shared/src/index.ts
shared/tests/fetch-video.test.ts
agent/src/tools/names.ts
agent/src/tools/fetch-video/config.ts
agent/src/tools/fetch-video/types.ts
agent/src/tools/fetch-video/process.ts
agent/src/tools/fetch-video/network.ts
agent/src/tools/fetch-video/service.ts
agent/src/tools/fetch-video/registration.ts
agent/src/tools/fetch-video/index.ts
agent/src/agents/supervisor/types.ts
agent/src/agents/supervisor/policy.ts
agent/src/agents/supervisor/runtime.ts
agent/src/index.ts
agent/src/fetch-video.test.ts
agent/src/supervisor.test.ts
.env.example
.gitignore
README.md
docs/architecture/fetch-video.md
docs/architecture/supervisor.md
```
