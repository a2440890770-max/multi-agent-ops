# Research 与 Supervisor 共享交接契约

当前实现共享 Zod Schema、引用/范围校验、Supervisor 接入适配、[Research SDK 子 Agent 定义](research-agent.md)及[受限网页工具/本地来源登记](research-web.md)。Skill 加载器、真实研究执行器、热榜业务采集步骤、数据库及页面仍未接通；没有发起付费模型请求。固定测试资料中的 Skill、来源和工具记录仅为离线样例。

Research 正式 System Prompt 已保存到 `agent/src/agents/research/prompt.ts`，通过 `buildResearchSystemPrompt()` 获取，版本为 `RESEARCH_PROMPT_VERSION = research-d9-v2`，并从 agent 包入口导出。`createResearchAgentDefinition()` 将它与报告 JSON Schema 组合为 SDK 定义，`createResearchIntegration()` 要求宿主显式提供真实业务适配器。创建这些对象不会启动 Agent、加载 Skill 或调用工具。

## 契约分层

定义位于 `shared/src/schemas/research.ts`，业务校验位于 `research-validation.ts`，均从 shared 包导出。Schema 保持可导出 draft-7 JSON Schema，引用与授权等跨字段约束单独校验。

| 契约                           | 提供方               | 用途                                                                                 |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `ResearchRequestSchema`        | Supervisor           | topic、objective、带稳定 ID/核心性/理由的问题、范围、参考资料引用                    |
| `ResearchInputsSchema`         | 后端                 | 子步骤 ID、initial/supplement、抖音图文背景、登记资料、补充范围、时间/Skill/资源配置 |
| `ResearchContextSchema`        | 后端结合分派要求构建 | 任务/尝试/步骤/快照、授权、选中项目、研究要求、完整历史报告及执行背景                |
| `ResearchReportSchema`         | Research 模型        | 研究摘要、问题覆盖、分型结论、Skill 章节、证据、缺口、冲突、角度、警告、变更         |
| `ResearchAcceptedResultSchema` | 接入适配器           | 校验后的报告和真实来源/内容/调用记录、结果版本、授权与 Trace 元数据                  |
| `ResearchRunResultSchema`      | 后端执行器           | reported，或 failed/cancelled 且 report 为 null 的失败记录                           |

热榜只展示 API 信息，不在用户选定前进行单项目研究。`GithubHotListSchema` 描述后端冻结的展示快照，不是 XXAPI 原始 HTTP 响应 Schema；现有 `data: unknown` 请求适配器尚需后续业务解析。未知排名口径为 null，不捏造统计周期。

## Supervisor 迁移

Supervisor 输入版本为 `2.0`，Prompt/工具策略版本为 `supervisor-d9-v2` / `supervisor-d9-tools-v3`。调用方必须迁移，不静默接受旧版字段。

- 新增 `hotList`、`selectedProject`、`researchContext.inputs`，触发原因增加 hot_list_loaded / project_selected。
- 新增最终决定 `awaiting_selection`，引用当前有候选的热榜快照。空榜/采集失败仍由执行器明确处理，不能伪装成等待可选项目。
- 原生 SDK `Agent` 工具不新增自定义参数。Supervisor 将 ResearchRequest JSON 写入原有 prompt 字符串，后端在授权消耗前解析并校验，然后注入完整上下文；仍只调用命名 research 子 Agent。
- `SupervisorResearchView` 是共享 `ResearchAcceptedResult` 的类型别名，不维护另一份事实/缺口定义。
- `contentBrief.usableFactIds` 改为 `usableClaimIds`，允许交付事实、注明归属的观点、有依据的推断。Content 必须解析所引用报告的完整 claim，保留类型、归属、证据和限制。
- 当前采用结果列表按顺序传入，最后一份为当前报告。所有结果必须属于同一任务、当前尝试及当前选择记录。换尝试后不复用旧报告；旧结果仅用于历史回查。

## 来源与证据

来源区分 primary、third_party、user_provided、unknown；来源性质、实际读取内容和用户确认由适配器根据真实登记记录提供。模型只能引用登记 ID，不能自行授予“官方/一手”属性或认证用户确认。

`materials` 记录内容版本、实际文本/产物 ID、获取时间、是否截断、视频实际覆盖范围、字幕/转写 segments、抽帧 framePositions 及一手确认记录。`firstHandConfirmation.materialVersion` 必须等于材料版本；正文自称已确认无效。已确认用户材料支持结论时必须保留“用户提供，未经外部独立核验”。未确认用户材料不能直接作为事实依据。

网页登记通过 `ResearchWebSnapshotSchema` 保存真实来源、材料版本/哈希及工具调用；配置和官网授权分别由 `ResearchWebConfigSchema`、`OfficialSiteGrantSchema` 校验。新增的 `sdk_processed` 材料只作线索，不能被 evidence 引用；原文证据只能来自实际读取并保存的内容。

引用链为 question → claim → evidence → material → source。证据位置支持：

- text：实际保留文本的 UTF-16 `[startOffset, endOffset)` 区间，excerpt 必须与该区间完全相同。截断文本只定位已取得部分。
- video：字幕或转写材料中的原视频时间范围，边界须匹配登记分段，摘录必须来自对应分段文本，不能用标题推测内容。保留媒体工具返回的原视频时间偏移；音轨先于首个画面时可出现负值。
- frame：已登记的帧 ID 和原视频时间点，必须与 framePositions 完全匹配并在材料覆盖范围内。后续媒体登记器须从真实工具产物填充这些位置；Schema 不替代资产/哈希校验或视觉分析。

核心事实须有直接的一手证据或真实确认的用户材料，搜索摘要不能代替核心事实的一手证据。第三方观点须有归属和限制；推断须有证据或前提、限制，前提引用不能循环。自动校验无法证明自然语言结论确实得到证据支持，也不能代替来源权威性和创新比较的语义审核。

## 状态与失败

- completed：问题和必需章节都有依据，没有未解决缺口，三个必需站点搜索均有尝试记录；可选视频失败允许保留 completed，但必须保留真实失败记录和关联警告。
- partial：有效报告存在未解决问题、缺口或证据不足章节。章节保留但不填造结论，关联对应缺口。Supervisor 接收合法 partial，核心缺口阻断，非关键缺口排除并警告后才能继续。
- failed/cancelled：执行器记录，无法形成可采用报告时 report 为 null，不把故障伪装成模型研究结论。

SDK 子 Agent 执行 completed 与研究报告业务 completed 不同。子 Agent 正常完成可以返回 partial 报告。已许可的资料工具失败不自动中止整个会话；身份不符、宿主权限拒绝、取消/中断仍会终止。网页范围/额度拒绝不执行工具，可继续整理已有资料。应用层不自动重试网页调用，失败后由 Agent 在同轮剩余额度内决定是否再次调用，新调用单独计次、计时。网页超时会停止当前 SDK 会话，不自动重启。报告格式纠正仍待结果适配器实现，受显式 limits 限制，不得重新搜索、抓榜或解析视频。共享 Schema 本身不执行重试。

## 补充研究与版本

每次新授权仅研究 `supplementScope.questionIds` 指定问题及关联缺口。范围由后端提供，Supervisor 请求必须与其一致；允许用户明确授权新的补查问题。原有核心问题不能删除或降级，Research 可追加发现的问题。研究工具每次调用仍须检查项目、站点和本轮范围，输入文本不授予权限。

新版输出完整报告，必须保留旧来源、材料和证据。结果版本递增并引用 parentResultId；原有结论/缺口变化以及新增项须记录 changes。正文只保留最新有效结论，撤回/被替代的旧结论通过旧结果版本和变更记录回查。

网页默认值已按确认的资源规则实现，见[网页工具配置](research-web.md)。真实预算、授权原子消耗、模型调用和数据库持久化仍由接入方执行，不能根据模型声称“已搜索”生成工具记录。completed 报告还会核对本轮真实三平台搜索记录，不能靠历史调用冒充本轮已尝试。

## 本批文件与验证

- `shared/src/schemas/research.ts`、`research-validation.ts`：新契约及业务校验。
- `shared/src/schemas/supervisor.ts`、`shared/src/index.ts`：Supervisor 升级及共享导出。
- `agent/src/agents/supervisor/{types,validation,policy,prompt,runtime}.ts`：原生分派、接收及角色规则同步。
- `shared/tests/research.test.ts`、`fixtures/research.json`、`supervisor.test.ts`，`agent/src/supervisor.test.ts`：固定资料、兼容性、缺口/版本/权限及注入测试。
- `docs/architecture/supervisor.md`、本文件：迁移和责任边界。

本地验证使用 npm run contract:check、npm run typecheck、npm test、npm run build，并对改动文件运行 ESLint/Prettier。离线注入测试不等于真实模型/平台联调验收。
