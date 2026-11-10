# Research SDK 子 Agent 定义

本批把正式 Prompt 和共享报告契约接入原生 SDK 子 Agent 定义，提供 `createResearchAgentDefinition()` 和 `createResearchIntegration()`，均从 agent 包入口导出。Supervisor 仍通过原生 `Agent` 工具分派命名的 research，没有增加第二个 query 会话或自定义 Agent 循环。

现已提供[受限搜索/读取与本地来源登记](research-web.md)，须通过 `webTools` 显式接入。项目研究 Skill 已接入宿主预加载；视频 Skill、授权存储、报告解析/有限格式纠正和数据库/页面执行器仍待实现。本次 Skill 接入未运行测试、构建或付费模型请求，历史离线测试不代表本次改动或真实模型联调已验收。

## 定义与工具

`agent/src/agents/research/definition.ts` 中的定义固定使用正式 Prompt，并附加从共享 `ResearchReportSchema` 生成的 draft-7 JSON Schema。定义继承主模型，前台运行，关闭自动 CLAUDE.md 继承，不设置长期 memory；不允许调用方覆盖 Prompt、模型、Skill 或其他 SDK 配置。

工具必须逐项传入 `tools`：只接受 WebSearch、WebFetch 和四个已经注册的媒体工具名。无默认全量工具，不接受通配符、通用 Read/Bash、发布或其他 Agent。显式空数组表示无工具，不继承父 Agent 的工具。声明允许搜索不代表可以访问任意站点；每次调用仍交由 `authorizeTool` 校验。

`maxTurns` 必须显式提供；Supervisor 注入时取该值与主会话上限的较小值。媒体工具还必须通过 `mediaTools` 提供实际注册，声明与注册逐项一致，并在 Supervisor 入口校验任务、尝试、输入快照及授权绑定。未声明的注册不能偷偷扩大工具集合。

## 受控 Skill 预加载

用户已确认[项目研究 Skill](../../agent/skills/github-project-research/SKILL.md) 的方法与六个必需章节，版本 `1.0.0`。`createResearchAgentDefinition()` 读取该固定路径的完整正文，核对文件名称、版本及章节表后加入 Research 的系统 Prompt；文件缺失或配置不一致直接报错，不退回仅有名称的 Prompt。

SDK 的 `skills: []` 继续关闭自动发现。实际加载由宿主完成，不开放 Skill 工具、通用 Read/Bash、用户或项目目录中的其他 Skill。加载只读取打包文件，不调用模型或取证工具。发布 Agent 包时须同时保留 `agent/skills` 与 `agent/dist` 的相对位置；源代码与构建产物使用同一固定资产路径。

上下文装配方通过 `getGithubProjectResearchSkillMetadata()` 获取 `{ name, version, requiredSections }` 的独立副本，写入冻结输入的 `researchContext.inputs.runtimeContext.skills`。这个 getter 仅提供配置，实际读取发生在创建定义时。正式工厂提供 `validateRuntimeContext`，Supervisor 在启动 SDK 前调用；工厂在绑定网页、消耗授权及结果适配器执行前再次核对。缺章、标题或版本不符、声明未加载的其他 Skill 均拒绝，不静默改写输入快照。结果的 Skill 元数据和章节覆盖继续由共享契约校验。

`video-content-extraction` 仍未提供，不能在输入或结果中声明已加载；视频能力按缺失规则记录限制。底层自定义 `ResearchIntegration` 的可选校验接口保留兼容；真实任务应使用正式工厂，不能把自定义定义当成已预加载的正式 Skill。

## 接入方式

调用方从自己的真实业务服务提供三个适配器后再调用：

```ts
const research = createResearchIntegration({
  tools: ['WebSearch', 'WebFetch'],
  maxTurns: researchLimits.maxTurns,
  webTools: createResearchWebController({
    config: readResearchWebConfig(preparedEnvironment),
    officialSites: confirmedOfficialSites,
  }),
  claimAuthorization: adapters.claimAuthorization,
  authorizeTool: adapters.authorizeTool,
  acceptResult: adapters.acceptResult,
});

const result = await runSupervisor(context, {
  limits: supervisorLimits,
  research,
});
```

这里的 adapters、context 和 limits 由宿主构建，不存在默认授权成功或模拟研究结果。创建 definition / integration 本身不会联网或启动 SDK。

- claimAuthorization 接收已校验的 ResearchContext，检查实际执行依赖并原子消耗授权，跨调用防重。
- authorizeTool 对每次调用校验身份之外的项目、站点、来源/资产和本轮范围，以及实时资源限制。
- acceptResult 从真实子 Agent 返回中读取研究报告，根据真实记录组装来源、材料、工具尝试及版本/执行元数据，校验后持久化。不能把模型输出当作工具日志或用户确认记录。

配置 `webTools` 时，工厂在授权适配器前将其绑定到实际 ResearchContext；网页 hooks 执行范围/额度校验并登记资料，结果适配器通过 `getRecords()` 获取真实记录。独立正文失败时保留 SDK 处理结果作为线索；失败后由 Agent 决定是否在剩余额度内再次调用，每次新调用独立计时。具体 SDK 限制与默认配置见[网页工具说明](research-web.md)。

接入工厂在回调返回后再次执行共享业务校验、网页登记一致性校验，并检查 metadata.promptVersion 与实际 `research-d9-v2` 一致；Supervisor 继续检查执行/项目范围、父调用标识、核心问题和创作推进条件。工厂版本为 `research-definition-d9-v3`，写入 Supervisor 的 researchVersion 元数据。

## 输出约束的实际边界

项目锁定的 SDK 0.3.311 的 `AgentDefinition` 没有独立的 outputFormat 字段。因此报告 JSON Schema 附加到子 Agent Prompt，要求它返回单个 JSON 对象，再由宿主独立校验；这是提示约束，不是 SDK 保证的结构化输出。

Supervisor 的 query.outputFormat 仍使用 SupervisorOutputSchema，不能改成 ResearchReportSchema，否则会破坏主 Agent 的最终决定。原生 Agent 的完成状态与报告 completed / partial 分别处理。

报告解析和有限格式纠正仍由后续真实 Research 结果适配器实现，不能因为定义里附带 JSON Schema 就宣称已经完成。格式纠正不得重新调用搜索或媒体工具，不得重新消耗研究授权；超限必须显式失败。

## 验证与文件

- `agent/src/agents/research/definition.ts`：正式 SDK 定义及受限配置。
- `agent/src/agents/research/integration.ts`：接入工厂及实际适配器要求。
- `agent/src/agents/research/skills.ts`、`agent/skills/github-project-research/SKILL.md`：固定 Skill 加载、版本/章节配置及上下文校验。
- `agent/src/agents/research/index.ts`：导出。
- `agent/src/agents/supervisor/types.ts`、`runtime.ts`：受控 SDK 字段兼容、配置校验及轮数限制。
- `agent/src/research.test.ts`、`supervisor.test.ts`：工具隔离、原生命名分派、媒体匹配和结果校验的离线测试。本次新增预加载及配置不符时禁止 SDK/授权调用的用例，尚未执行。
- 本文件、`research-schema.md`、`supervisor.md`：当前实现和责任边界。
