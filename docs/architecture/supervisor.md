# D9 Supervisor 独立模块

2026-11-10 更新：独立服务和后端执行链现已接线，真实 Supervisor 已成功返回结构化决定并进入等待选题。引用约定已统一为共享宿主清单，Prompt 为 `supervisor-d9-v3`，见[引用清单实现与验证](../acceptance/d9-backend-agent-pr-2026-11-10.md)。下文较早阶段的未接线说明保留为历史记录。

当前已实现 Supervisor 的 Prompt、SDK 运行入口、权限和交接校验，以及 [Research 共享契约](research-schema.md)、接入接口和离线测试。数据库执行器、页面、真实 Research、Content、Review 和 Langfuse 上报尚未接入。健康检查继续返回 `canExecuteTasks=false`，不能把独立模块或离线样例视为已接通任务业务。

后续已增加 [fetch_video](fetch-video.md)、[extract_audio](extract-audio.md)、[transcribe_audio](transcribe-audio.md) 与 [extract_frames](extract-frames.md) 的受控 SDK 注册接入口：仅在 ResearchIntegration 逐项声明并注册时开放对应媒体工具，多工具通过 `combineResearchMediaRegistrations()` 共用 `research_media`。服务绑定当前任务、尝试、输入快照及研究授权，取消随 Supervisor 会话传播；本文件其余“未加载 MCP”的说明适用于没有显式媒体注册的默认运行。

## 已确认规则

- Supervisor 是固定四 Agent 流程的主协调者，D9 只启用澄清、Research 分派及研究结果判断。
- Supervisor 不直接搜索或读取资料，统一通过 SDK 原生 `Agent` 工具分派命名的 `research`。
- 一次用户授权只开展一轮研究。Research 内部可以搜索和读取多次；Supervisor 不自动追加或恢复研究。
- 缺少关键要求、要求冲突时等待澄清。答复非空不等于语义充分；重新调用 Supervisor 判断。
- 关键证据缺口必须等待用户处理。非关键缺口逐项排除相关说法，并保留关联警告后才可交接。
- 资料和子 Agent 返回内容不能改变权限、正式配置和人工审批要求。D9 的 `ready_for_content` 只是研究阶段交接，不等于任务产出就绪、审核通过或批准发布。

## 入口和上下文

从 `agent/src/index.ts` 导入 `runSupervisor(context, options)`。输入和最终输出分别使用 shared 中的 `SupervisorContextSchema`、`SupervisorOutputSchema`，不另造业务字段。Supervisor 输入已升级到 `schemaVersion: "2.0"`，不兼容旧版输入；Research 自身契约版本为 `1.0`。输入采用单条 `client_composed` 消息，避免任务中的 `@path` 或斜线命令触发 CLI 附件展开。

上下文必须声明实际版本：

- `promptVersion`：导出的 `SUPERVISOR_PROMPT_VERSION`，当前为 `supervisor-d9-v2`。
- `toolPolicyVersion`：导出的 `SUPERVISOR_TOOL_POLICY_VERSION`，当前为 `supervisor-d9-tools-v3`。
- `configVersion`：调用方当前冻结的业务配置版本。

调用方需要显式传入 `limits`：`timeoutMs`、`maxTurns`、`maxBudgetUsd`、`maxOutputTokens`、`maxOutputAttempts`。超时、调用方取消和权限拒绝都会停止接收结果并关闭会话，迟到结果不再被采用。输出纠正次数有限，未成功时显式失败；模块不会重新执行整个 SDK 会话或重新分派研究。

模型沿用项目 DeepSeek 配置和凭据隔离。模块不读取 `.env`；调用方负责准备环境。默认 transport 是真实 SDK `query()`，**显式调用会产生模型费用**。自动测试全部注入离线 transport，不调用真实模型、搜索或数据库。

SDK 的内部请求和估算预算仍由 SDK 管理；`maxTurns` 和 `maxBudgetUsd` 不等于后端逐请求账本。元数据中的 `sdkEstimatedCostUsd`、`modelUsage` 仅为 SDK 报告，不代表供应商账单。接入业务执行器前仍需实现完整计价、资源预占、逐请求记账、执行权和结果持久化，不能宣称已满足生产任务的全部资源限制。

## 原生分派与角色权限

采用 SDK 的 `agent: 'supervisor'` 和 `agents` 注册定义，主 Agent 仅开放 `Agent`。全局可用工具集合包含 Research 所需工具，但通过主 Agent 定义和带身份检查的 hooks 阻止 Supervisor 使用这些工具。子 Agent 的工具显式列出，避免默认继承。[SDK 子 Agent 说明](https://code.claude.com/docs/en/agent-sdk/subagents)

每次运行隔离 `cwd` 和 `CLAUDE_CONFIG_DIR`，不自动加载用户/项目设置、Skills、插件或外部 MCP，禁用内置通用 Agent，并拒绝 fork。正式 Research 工厂由宿主预加载固定的项目研究 Skill 全文到子 Agent Prompt，详见[受控预加载](research-agent.md#受控-skill-预加载)。分派只接受 `research`，拒绝后台执行、恢复、模型覆盖、工作树隔离和未知字段；Agent 的 `prompt` 必须为 `ResearchRequestSchema` 的 JSON 字符串，运行时先校验，再结合后端的 `researchContext.inputs`、选中项目、授权及本次采用的完整历史报告构建 `ResearchContextSchema`；另附原始要求及澄清历史，强制前台等待结果。格式不合法不消耗授权，不将任意自由文本作为可执行研究要求。

权限 hooks 处理自身的异常并显式拒绝，避免当前锁定 SDK 在 hook 抛出异常后继续默认权限流程。Research 必须由本次合法分派产生的 `agent_id` 发起工具调用，且每次通过接入方资料范围检查。当前允许显式声明的工具名为 `WebSearch`、`WebFetch`、`Read`、`mcp__research_media__fetch_video`、`mcp__research_media__extract_audio`、`mcp__research_media__transcribe_audio` 和 `mcp__research_media__extract_frames`；没有接入方时不开放任何 Research 工具。

## Research 接入接口

现在可使用 [Research 接入工厂](research-agent.md) 构建正式 SDK 子 Agent 定义。工厂要求宿主提供真实授权、逐次工具范围和结果登记适配器；不提供默认授权成功或模拟结果。需要分派而未接入时仍返回 `RESEARCH_NOT_CONFIGURED`，没有研究需求的澄清判断仍可运行。

显式配置 `ResearchIntegration.webTools` 后，原生 WebSearch/WebFetch hooks 接入[范围校验、额度和来源登记](research-web.md)。正常失败保留记录，由 Research 决定是否再次调用，每次新调用单独计次、计时。网页范围/额度拒绝只拒绝该次调用；身份与宿主授权错误仍终止会话。网页总时限默认 60 秒，到期返回 `RESEARCH_WEB_TIMEOUT` 并停止整个 SDK 会话；不会自动重启。完成前等待本地登记写入，写入失败返回 `RESEARCH_WEB_REGISTRY_FAILED`；结束和取消均清理仍在运行的网页调用。

`ResearchIntegration` 由后续 Research 模块提供：

定义允许显式声明固定的 model=inherit、skills=[]、background=false、omitClaudeMd=true 和 maxTurns。SDK 注入时保留子 Agent 的较小轮数上限，拒绝外部模型、后台运行、任意 Skill、记忆或未知字段覆盖。正式工厂不开放通用 Read，低层旧适配器的显式工具接口保持兼容。

| 成员                     | 调用方责任                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `version`、`definition`  | 提供版本、description、Prompt、明确的受限工具集合；模型继承项目配置                             |
| `validateRuntimeContext` | 正式工厂在启动 SDK 前校验真实加载的 Skill 与输入快照一致；底层旧适配器保留可选接口兼容          |
| `claimAuthorization`     | 在执行研究前原子消耗授权；须跨调用、重试和进程防重，不因旧输入快照而重复授权                    |
| `authorizeTool`          | 每次读取/搜索前验证域名、URL、资料归属和文件路径；默认无放行策略                                |
| `acceptResult`           | 核实真实来源/读取/工具记录，组装并持久化共享结果；接收合法 completed/partial 报告，拒绝无效结果 |

`SupervisorResearchView` 现在直接别名到共享的 `ResearchAcceptedResult`，不再手工维护另一套事实/缺口索引。结果包含报告、真实来源、实际读取内容和覆盖范围、工具尝试、版本及执行元数据。`claimAuthorization`、`authorizeTool`、`acceptResult` 都能取得已校验的 `researchContext`。接入方须从真实登记记录构建来源和材料，不得把模型自述当作读取成功、来源性质或用户确认的证明。

`acceptResult` 后 Supervisor 再调用共享的 `validateResearchResult(result, researchContext)`，检查问题、Skill 章节、证据位置、引用、范围、状态、必需搜索和历史变更。结构化校验不证明自然语言结论真实；证据是否直接支持结论、创新比较是否充分仍需 Research 语义判断及后续审核。

`acceptedResearchResults` 必须与输入的 `acceptedResultIds` 一一对应且顺序一致，最后一个是当前采用的研究结果。新一轮结果追加到末尾，Supervisor 必须引用最新结果，不能用旧报告掩盖新缺口。只允许当前 `taskId + attemptId + selectedProject` 内的报告。补充研究带最新完整报告和后端明确授权的问题范围，保留原证据及变更记录；新尝试不复用旧报告。报告实际数据库持久化仍由后续接入方实现。

原生 Agent 完整结果通过 `acceptResult` 后，`PostToolUse` 才将返回给主 Agent 的原始报告替换为已校验数据。失败时停止调用，不让错误结果形成有效交接。主调用的 `outputFormat` 不替代 Research 的独立校验。[SDK hooks 说明](https://code.claude.com/docs/en/agent-sdk/hooks)

## 最终输出及错误

只接受成功 SDK result 中通过共享 Schema 的 `structured_output`，不从普通 JSON 文本回退提取。结构化输出的 SDK 机制见[官方说明](https://code.claude.com/docs/en/agent-sdk/structured-outputs)。

业务校验还检查：

- 引用必须来自当前上下文、资料、记忆或已校验研究索引。
- 默认受众/语气与实际配置一致；合理默认仅用于没有配置的字段。
- 研究相关决定必须引用最新已校验结果。
- `needs_materials` 必须列出全部关键缺口。
- `awaiting_selection` 引用当前有候选的热榜快照；未选择前不能授权或开展项目研究。
- `ready_for_content` 不得存在关键缺口；`usableClaimIds` 只引用最新报告中的结论，所有非关键缺口必须有排除项和关联警告。
- 结论保留 fact / third_party_opinion / inference 类型、观点归属及限制，Content 按 ID 读取完整结论，不把观点/推断改成已验证事实。
- 可选资料读取失败允许继续形成报告并保留警告；取消、越权、未知身份及主会话故障仍会停止。业务报告 partial 与 SDK 子 Agent 未完成是两回事。

模型仍负责判断用户答复是否充分、排除说法后是否满足主要目标等语义问题，结构校验不能替代模型行为和后续审核验收。

`SupervisorError.code` 提供明确错误，例如 `RESEARCH_NOT_CONFIGURED`、`RESEARCH_NOT_AUTHORIZED`、`RESEARCH_ALREADY_DISPATCHED`、`SUPERVISOR_OUTPUT_ATTEMPTS_EXHAUSTED`、`SUPERVISOR_EVIDENCE_INSUFFICIENT`、`SUPERVISOR_CANCELLED`、`SUPERVISOR_TIMEOUT`。错误不转发原始供应商或资料内容。

`onEvent` 包含 `research_tool_failed` 事件，只输出任务/尝试/步骤/快照标识、事件类型和必要错误码，不包含任务正文、资料、凭据或推理内容。回调故障只累计 `observationErrors`，不会重跑模型或研究。该接口尚未连接 Langfuse。

## 离线验证

```sh
npm run build --workspace=shared
npm run test --workspace=agent
npm run typecheck
npm run build
```

测试注入 SDK 消息和工具 hooks，覆盖分派权限、单轮与跨调用授权、Research 未接入、来源引用、关键缺口、非关键排除、无效澄清答复、结构化输出纠正、超时取消、迟到结果和观测故障。资料注入用例验证运行时拒绝越权、原始研究报告不直接传入主 Agent；没有真实模型行为验收，不能宣称真实 DeepSeek + SDK 子 Agent 分派已联调通过。
