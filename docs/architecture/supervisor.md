# D9 Supervisor 独立模块

本批只实现 Supervisor 的 Prompt、SDK 运行入口、权限和交接校验、Research 接入接口及离线测试。数据库执行器、页面、真实 Research、Content、Review 和 Langfuse 上报尚未接入。健康检查继续返回 `canExecuteTasks=false`，不能把独立模块或离线样例视为已接通任务业务。

## 已确认规则

- Supervisor 是固定四 Agent 流程的主协调者，D9 只启用澄清、Research 分派及研究结果判断。
- Supervisor 不直接搜索或读取资料，统一通过 SDK 原生 `Agent` 工具分派命名的 `research`。
- 一次用户授权只开展一轮研究。Research 内部可以搜索和读取多次；Supervisor 不自动追加或恢复研究。
- 缺少关键要求、要求冲突时等待澄清。答复非空不等于语义充分；重新调用 Supervisor 判断。
- 关键证据缺口必须等待用户处理。非关键缺口逐项排除相关说法，并保留关联警告后才可交接。
- 资料和子 Agent 返回内容不能改变权限、正式配置和人工审批要求。D9 的 `ready_for_content` 只是研究阶段交接，不等于任务产出就绪、审核通过或批准发布。

## 入口和上下文

从 `agent/src/index.ts` 导入 `runSupervisor(context, options)`。输入和最终输出分别使用 shared 中的 `SupervisorContextSchema`、`SupervisorOutputSchema`，不另造业务字段。输入采用单条 `client_composed` 消息，避免任务中的 `@path` 或斜线命令触发 CLI 附件展开。

上下文必须声明实际版本：

- `promptVersion`：导出的 `SUPERVISOR_PROMPT_VERSION`，当前为 `supervisor-d9-v1`。
- `toolPolicyVersion`：导出的 `SUPERVISOR_TOOL_POLICY_VERSION`，当前为 `supervisor-d9-tools-v1`。
- `configVersion`：调用方当前冻结的业务配置版本。

调用方需要显式传入 `limits`：`timeoutMs`、`maxTurns`、`maxBudgetUsd`、`maxOutputTokens`、`maxOutputAttempts`。超时、调用方取消和权限拒绝都会停止接收结果并关闭会话，迟到结果不再被采用。输出纠正次数有限，未成功时显式失败；模块不会重新执行整个 SDK 会话或重新分派研究。

模型沿用项目 DeepSeek 配置和凭据隔离。模块不读取 `.env`；调用方负责准备环境。默认 transport 是真实 SDK `query()`，**显式调用会产生模型费用**。自动测试全部注入离线 transport，不调用真实模型、搜索或数据库。

SDK 的内部请求和估算预算仍由 SDK 管理；`maxTurns` 和 `maxBudgetUsd` 不等于后端逐请求账本。元数据中的 `sdkEstimatedCostUsd`、`modelUsage` 仅为 SDK 报告，不代表供应商账单。接入业务执行器前仍需实现完整计价、资源预占、逐请求记账、执行权和结果持久化，不能宣称已满足生产任务的全部资源限制。

## 原生分派与角色权限

采用 SDK 的 `agent: 'supervisor'` 和 `agents` 注册定义，主 Agent 仅开放 `Agent`。全局可用工具集合包含 Research 所需工具，但通过主 Agent 定义和带身份检查的 hooks 阻止 Supervisor 使用这些工具。子 Agent 的工具显式列出，避免默认继承。[SDK 子 Agent 说明](https://code.claude.com/docs/en/agent-sdk/subagents)

每次运行隔离 `cwd` 和 `CLAUDE_CONFIG_DIR`，不加载用户/项目设置、Skills、插件或外部 MCP，禁用内置通用 Agent，并拒绝 fork。分派只接受 `research`，拒绝后台执行、恢复、模型覆盖、工作树隔离和未知字段；运行时补入原始要求及澄清历史，强制前台等待结果。

权限 hooks 处理自身的异常并显式拒绝，避免当前锁定 SDK 在 hook 抛出异常后继续默认权限流程。Research 必须由本次合法分派产生的 `agent_id` 发起工具调用，且每次通过接入方资料范围检查。当前预留工具名只有 `WebSearch`、`WebFetch`、`Read`；没有接入方时不开放任何 Research 工具。

## Research 接入接口

本批不提供默认 Research 实现。需要分派而未接入时返回 `RESEARCH_NOT_CONFIGURED`，不会用模拟结果代替。没有研究需求的澄清判断仍可运行。

`ResearchIntegration` 由后续 Research 模块提供：

| 成员                    | 调用方责任                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `version`、`definition` | 提供版本、description、Prompt、明确的受限工具集合；模型继承项目配置                                     |
| `claimAuthorization`    | 在执行研究前原子消耗授权；须跨调用、重试和进程防重，不因旧输入快照而重复授权                            |
| `authorizeTool`         | 每次读取/搜索前验证域名、URL、资料归属和文件路径；默认无放行策略                                        |
| `acceptResult`          | 验证原生子 Agent 完成状态、研究业务 Schema、事实来源及任务归属；拒绝部分/失败结果，持久化后返回结果视图 |

本模块的 `SupervisorResearchView` 是适配器提供的可信索引投影，**不是 Research 业务输出契约**。它包含任务/尝试标识、结果 ID、来源 ID、带来源的事实索引、缺口及完整已校验数据。缺口的 `severity` 是适配器提供的判断；Supervisor 不能自行把 `core` 降级成 `noncritical`。真实来源核验和缺口判断仍需后续 Research 及其校验实现。

`acceptedResearchResults` 必须与输入的 `acceptedResultIds` 一一对应且顺序一致，最后一个是当前采用的研究结果。新一轮结果追加到末尾，Supervisor 必须引用最新结果，不能用旧报告掩盖新缺口。最新结果需包含当前仍未解决的全部缺口；本批不负责自动合并、解决或持久化历史缺口。

原生 Agent 完整结果通过 `acceptResult` 后，`PostToolUse` 才将返回给主 Agent 的原始报告替换为已校验数据。失败时停止调用，不让错误结果形成有效交接。主调用的 `outputFormat` 不替代 Research 的独立校验。[SDK hooks 说明](https://code.claude.com/docs/en/agent-sdk/hooks)

## 最终输出及错误

只接受成功 SDK result 中通过共享 Schema 的 `structured_output`，不从普通 JSON 文本回退提取。结构化输出的 SDK 机制见[官方说明](https://code.claude.com/docs/en/agent-sdk/structured-outputs)。

业务校验还检查：

- 引用必须来自当前上下文、资料、记忆或已校验研究索引。
- 默认受众/语气与实际配置一致；合理默认仅用于没有配置的字段。
- 研究相关决定必须引用最新已校验结果。
- `needs_materials` 必须列出全部关键缺口。
- `ready_for_content` 不得存在关键缺口；选用事实必须来自研究索引，所有非关键缺口必须有排除项和关联警告。

模型仍负责判断用户答复是否充分、排除说法后是否满足主要目标等语义问题，结构校验不能替代模型行为和后续审核验收。

`SupervisorError.code` 提供明确错误，例如 `RESEARCH_NOT_CONFIGURED`、`RESEARCH_NOT_AUTHORIZED`、`RESEARCH_ALREADY_DISPATCHED`、`SUPERVISOR_OUTPUT_ATTEMPTS_EXHAUSTED`、`SUPERVISOR_EVIDENCE_INSUFFICIENT`、`SUPERVISOR_CANCELLED`、`SUPERVISOR_TIMEOUT`。错误不转发原始供应商或资料内容。

`onEvent` 只输出任务/尝试/步骤/快照标识、事件类型和必要错误码，不包含任务正文、资料、凭据或推理内容。回调故障只累计 `observationErrors`，不会重跑模型或研究。该接口尚未连接 Langfuse。

## 离线验证

```sh
npm run build --workspace=shared
npm run test --workspace=agent
npm run typecheck
npm run build
```

测试注入 SDK 消息和工具 hooks，覆盖分派权限、单轮与跨调用授权、Research 未接入、来源引用、关键缺口、非关键排除、无效澄清答复、结构化输出纠正、超时取消、迟到结果和观测故障。资料注入用例验证运行时拒绝越权、原始研究报告不直接传入主 Agent；没有真实模型行为验收，不能宣称真实 DeepSeek + SDK 子 Agent 分派已联调通过。
