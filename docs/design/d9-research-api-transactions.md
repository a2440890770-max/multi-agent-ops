# D9 选题与研究授权：接口与事务设计

> 2026-11-10 实现更新：后端 → Agent 服务 → Supervisor → 原生 Research 分派、一次性授权消费、网页登记、报告采用及最小页面已接线并完成离线验收。实际 `.env`、业务库和付费调用未动；默认关闭。见[执行链验收及启用方案](../acceptance/d9-backend-agent-pr-2026-11-10.md)。下文未实现描述保留为此前阶段记录。

2026-11-09，Asia/Shanghai。依据[已确认决定](d9-selection-research-authorization.md)及当前工作树设计后续实现。**本文是工程方案，新增接口、共享结构和数据库变更尚未实现或验收。** 本轮只修改文档，不修改业务代码或配置，不连接数据库、不执行迁移、不调用模型或外部 API。下文路径均相对于 `/api/v1`。

后续进展：共享契约和三组命令事务已实现，新增资料存储迁移已在隔离实例验证，详见[实现验收记录](../acceptance/d9-research-commands-2026-11-09.md)。本文保留原设计阶段描述；私有 Agent 回调、运行时授权消耗、实际出站和报告采用仍是待实施方案，正式入口保持关闭。用户已确认旧补交资料不自动沿用、补查只选既有问题。

## 1. 原子边界与实现基线

三个用户动作分别只发一个命令、只开一个业务事务：

| 用户动作           | 同事务必须一起提交                                                                                            | 不在该事务中执行                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 选定并深入研究     | 不可变选题、initial 待用授权、Supervisor 排队、任务 revision、审计、幂等响应                                  | 模型调用、Research 分派、授权消耗  |
| 重新执行并授权研究 | 新 attempt、新 initial 待用授权、复用原选题、Supervisor 排队、任务指针与 generation、批准失效、审计、幂等响应 | 重新抓榜、复制旧报告、恢复旧授权   |
| 提交资料并授权补查 | 提交批次、材料与一手确认、supplement 待用授权、Supervisor 排队、任务 revision、审计、幂等响应                 | 抓取资料链接、消耗授权、覆盖旧报告 |

任一插入、更新、审计或幂等记录失败，整个动作回滚。提交成功仅表示用户动作已接受，不能表示研究已启动或报告已完成。调度器只看已提交的 `queued` attempt/step，不依赖 HTTP 进程提交后再发一条内存消息，因此提交后进程退出不会丢掉排队工作。

复用现有实现：

- [执行命令服务](../../backend/src/task-execution-service.ts)的 Session、成员复核、同团队归属、幂等锁、任务 revision 和任务累计预算。
- [0014 数据结构](../architecture/research-persistence.md)的选题唯一、initial 授权唯一、单份待用授权、单次消耗、报告父版本唯一及不可变历史约束。
- [执行权控制](../../backend/src/execution-ownership.ts)的当前 attempt、generation、租约和取消隔离，以及[资源控制](../../backend/src/execution-control.ts)的预占与保守结算。
- [Research 共享契约](../architecture/research-schema.md)及实际工具登记校验。

已有数据库触发器不能替代 HTTP 鉴权、执行权 token、scope 语义校验或材料真实性检查。`0000..0014` 已应用文件不回改；本文新增存储要求在后续新增迁移中实现。

## 2. 公共接口约定

写入沿用 `ops_session`、同源 `Origin`、`X-CSRF-Token` 和 `Idempotency-Key`。角色为同团队 active `admin/operator`；这是研究资料访问确认，不是管理员专属的平台账号官方授权。对象越团队或不可访问统一返回 404。客户端不得提供操作者、确认时间、授权 ID、授权状态、模型配置、价格、工具策略或执行权 token。

请求均严格拒绝未知字段。`expectedRevision` 是正安全整数。task/attempt/snapshot/selection/authorization/submission 使用数据库 UUID；candidate/question/gap/result/material ID 沿用共享 Schema 的不透明字符串，不强制转为 UUID。正文保留原文和换行，不为生成指纹而 trim；空白正文判空但不保存修剪版。

三个命令成功均返回 `202 ApiSuccess<ResearchCommandResult>`，建议新增共享响应结构：

```ts
type ResearchCommandResult = {
  task: TaskDetail; // 本事务提交时的详情快照
  selection: SelectedProject;
  authorization: {
    id: string;
    attemptId: string;
    mode: 'initial' | 'supplement';
    baseResultId: string | null;
    consumedAt: null;
  };
  submissionId: string | null;
};
```

这是提交时响应；同键重放仍返回这份快照和 `meta.replayed=true`。当前授权是否已消耗、任务是否结束，以随后 GET 为准。`TaskDetail.agentExecution` 后续增加 `selectedProject`、待用授权摘要、最新报告摘要及三个操作的 `actions`，不返回内部完整 scope 或凭据。

### 2.1 选定并深入研究

`POST /tasks/:taskId/project-selection`，建议 operationId=`selectProjectAndAuthorizeResearch`。

```json
{
  "expectedRevision": 12,
  "attemptId": "11111111-1111-4111-8111-111111111111",
  "hotListSnapshotId": "22222222-2222-4222-8222-222222222222",
  "candidateId": "candidate-3",
  "authorizeResearch": true
}
```

`authorizeResearch` 必须是字面量 `true`，缺失或 false 都不能创建选题。请求不接收项目名称、仓库地址或额外研究问题，后端从冻结榜单取值。

前置条件：任务 open，无发布锁；当前为真实 agent attempt，generation 一致、未取消、状态为 `awaiting_selection`，无租约及排队/运行中的工作；任务尚无选题；榜单属于该 task/attempt，候选属于该榜单且有效。空榜不提供此动作。存在旧选题时，换键也不允许改选或再授权。

接受后保留同一 attempt，创建 initial 待用授权并排队一次 Supervisor，触发原因 `project_selected`。Supervisor 若仍需澄清，授权保持未消耗。

### 2.2 新 attempt 与新研究授权

`POST /tasks/:taskId/research-attempt-retries`，建议 operationId=`retryResearchAndAuthorize`。

```json
{
  "expectedRevision": 20,
  "previousAttemptId": "11111111-1111-4111-8111-111111111111",
  "reason": "补查执行中断后重新研究",
  "authorizeResearch": true
}
```

`reason` 沿用现有执行重试的非空规则；`authorizeResearch` 必须为 true。后端读取原选题，不接受新的 candidate、selection、榜单、报告或官网授权字段。

适用于已有选题、当前真实 agent attempt 已结束且为 `failed/cancelled` 的任务；不从正常等待态抢占工作槽，也不重启 lifecycle 已终止的任务。研究失败、Supervisor/执行器中断和人工停止后的重新执行共用此入口。旧 attempt ID 必须等于任务当前指针，无未解决的发布锁。沿用最多 100 次完整 attempt 的现有限制。

新 attempt 沿用原 `project_selections` 和 `github_hot_snapshots`，新 initial 授权 `baseResultId=null`；不复制旧报告、旧官网授权和旧补充资料为本轮输入。原始任务要求及已持久化的原始参考资料仍按权限冻结；上个 attempt 的报告和补交材料只供历史查看，重新使用需再次明确提交。新链第一份报告只能为版本 1。

已有 `/attempt-retries` 保留 mock 和未选题 agent 的原流程；**已有选题的 agent 必须继续拒绝旧入口**，避免无新授权启动或重新抓榜。前端依据 actions 展示“重新执行并授权研究”。

### 2.3 资料提交与补查授权

`POST /tasks/:taskId/research-supplements`，建议 operationId=`submitMaterialsAndAuthorizeResearch`。

```json
{
  "expectedRevision": 25,
  "attemptId": "11111111-1111-4111-8111-111111111111",
  "baseResultId": "research-result-1",
  "questionIds": ["question-maintenance"],
  "gapIds": ["gap-maintenance-evidence"],
  "materials": [],
  "confirmExistingMaterials": [],
  "officialSiteGrants": [{ "origin": "https://example.com", "pathPrefix": "/docs/" }],
  "authorizeResearch": true
}
```

该示例合法：**没有新资料也能针对选定问题明确授权一轮补查。** `materials`、`confirmExistingMaterials`、`officialSiteGrants` 均为必填数组，允许为空；`questionIds` 至少一项，`gapIds` 可以为空，各 ID 列表不得重复。所有问题/缺口来自当前采用的完整报告，所选缺口关联问题必须包含在 questionIds 中。不能通过选取缺口隐式扩大问题范围。本批页面不新增自由输入研究问题的入口。

前置条件：当前真实 agent attempt 为 `awaiting_materials` 或 `awaiting_content`，无租约、取消、排队/运行工作、待用授权和发布锁。允许在待创作时主动补查，前提是尚未启动 Content。`baseResultId` 必须等于当前 attempt 最新已采用完整报告；仅属于同任务的旧报告也不能作为基版。对基版、问题和缺口的检查在同一锁内完成。

每条新材料结构为 `{ clientRef, label, text, sourceUrl, confirmFirstHand }`：

- `clientRef` 在请求内唯一，仅映射返回的宿主材料 ID；`text/sourceUrl` 为可空字段，但至少有一个非空。支持纯粘贴文本、纯链接及两者并存，不接受文件或文件路径。
- `confirmFirstHand` 必须显式为 boolean。只登记链接时不能确认尚未读取的远端正文；false 的用户文本可作线索，不能直接当作已确认事实。
- 后端生成 source/material ID、version、内容哈希和捕获时间。纯链接登记为来源线索，不伪造非空正文、网页读取成功或 evidence。
- 链接登记不扩大抓取权限；范围外官网链接须在本次 `officialSiteGrants` 另列出并确认。提交阶段不联网验证或抓取。

`confirmExistingMaterials` 的条目为 `{ materialId, materialVersion, contentSha256 }`，仅可指向基版中已有的用户提供文本；锁内比对真实材料和哈希。后端记录新确认事件，生成新的材料版本快照，并建立旧版到新版的映射；不修改旧报告/登记。**新快照分配新的 materialId**，version 递增，旧 ID 的内容与确认原样保留；否则现有共享校验会因同 ID 历史材料被改写而拒绝完整新报告。确认人和时间来自 Session 与数据库时钟，确认记录的 `materialVersion` 指向新快照版本。网页抓取材料不能通过此入口改称用户一手资料。输入变动后旧确认不自动迁移，必须再次确认。

每项资料和确认必须校验成功才整体提交；不采用“有效的先存、无效的略过”。补交文本仍是研究资料，不能修改原任务要求、核心性、Skill 或工具权限。请求字节数、条目数和文本长度上限应写进共享请求 Schema 与页面；这些传输保护值属于后续实现参数，不从本设计推断用户认可了新的模型或工具额度。

## 3. 冻结的授权 scope

建议新增严格的 `ResearchAuthorizationScopeSchema`，替代业务层任意 `Record<string, unknown>`。数据库继续保存 JSONB；宿主在创建、消耗、逐次工具准入、结果提交四处使用同版本 Schema 及跨字段校验。scope 由后端组装，客户端只提交上述选择及确认。

| scope 内容                                         | 冻结来源与要求                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `schemaVersion`、task/attempt/generation/selection | 当前数据库记录；selection 包含不可变仓库、原榜单及候选身份                                            |
| `mode`、`baseResultId`、`baseResultVersion`        | initial 均无基版；supplement 必须绑定当前 attempt 最新完整报告                                        |
| `taskInput`                                        | 原始要求、参考资料、输入 revision、澄清记录的 ID/版本及内容摘要；可重建原始输入                       |
| `researchMethod`                                   | 正式研究 Skill 名称/版本/内容哈希及六章、Prompt/工具策略/配置版本、抖音图文背景                       |
| `supplementScope`                                  | 明确 questionIds/gapIds 及报告中对应内容；initial 为 null，不能用自然语言正文覆盖                     |
| `materialRefs`、`submissionId`                     | 精确材料 ID/版本/内容哈希及确认事件；历史证据保留与本轮允许新读取分开                                 |
| `sources`                                          | 当前仓库及同仓库 raw、三平台受限搜索规则、本轮单独确认的官网路径；不接受全网或任意命令 scope          |
| `tools`                                            | 首批文本 Research 的 WebSearch/WebFetch 白名单；禁止通用 Read/文件、Shell、其他 Agent、视频与发布能力 |
| `limits`、`pricingRef`、`budgetTaskId`             | 已配置并冻结的调用/输出纠正/超时/费用规则及计价版本；资源限制取 scope 与实时剩余额度的较小值          |

授权 scope 的 `taskInput` 记录“授权当时用户已知的要求”。授权后 Supervisor 可能继续要求澄清：同 attempt 的追加答复以不可变记录进入**分派输入快照**，同时保留授权时输入，不改写 scope。后端校验答复未换项目、未扩大允许来源/工具/补查问题；只是解释原要求时可使用原待用授权。若答复要求扩大本轮权限，应继续等待并提示明确授权，不能擅自消费旧授权或自动替换它；本批不实现任意修改待用授权的入口。点击资料确认同样不能借正文追加官网权限。

分派时的 `ResearchContext` 仍使用已有共享 Schema；完整宿主 scope 不作为可供模型改写的权限数据。模型生成的 ResearchRequest 只能细化已授权目标；宿主必须核对项目、参考 ID、supplement 范围与问题核心性。不能把核心问题删除或降级来绕过交接门槛。

## 4. 官网／文档的单轮访问范围

`officialSiteGrants` 必须显式提交；每次打开补查表单默认空数组。历史范围可供参考展示，但不得默认勾选或由后端合并。新 attempt 的 initial 授权始终没有额外官网范围。项目文档中现有 `approvedBy=configuration` 的低层工具能力不作为该业务流程自动授权的来源。

后端仅接受 HTTPS、无凭据、无 query/fragment 的规范 origin 与绝对路径，规范化后再向用户展示其实际范围。grant 冻结在本次 authorization.scope；转成现有 `OfficialSiteGrant` 时使用 `approvedBy='user_confirmation'`、`approvalRef=authorizationId`，身份与时间从授权记录取。其有效性等于该授权的本轮运行期，不能作为下一轮的通行凭证。

路径按边界匹配：`/docs/` 只包含此目录及其子路径；无尾斜线的 `/docs` 按 `/docs` 和 `/docs/…` 匹配，不匹配 `/docs-old`。`/` 明确表示整个 origin，仅当用户明确提交该范围才成立。拒绝反斜线、编码斜线/反斜线、路径穿越及多重编码等歧义；hostname 精确匹配，不隐含子域名。抓取前校验范围和公共 DNS，独立正文请求逐跳重新核对，跨范围跳转拒绝。

原生 SDK 网页工具的内部请求/跳转并非完全可观测，现有[网页工具说明](../architecture/research-web.md)已经记录这一限制。**仅靠 SDK 调用前 URL 与调用后最终 URL 校验，不能满足本轮授权逐跳生效的要求。** 上线接线须让受限网页适配器控制实际出站读取与逐跳校验；若保留原生工具且无法约束其中间访问，该能力不能作为符合本设计的生产链路验收。不得以结果拒收冒充访问前已阻止。实现方式需单独评审，不在本文中声称已解决。

## 5. 事务共用模板、幂等和锁序

沿用 READ COMMITTED 加显式行锁和唯一约束即可，不依赖进程内互斥。人工命令复用现有外层锁序：幂等 advisory lock → editorial team advisory lock → active member 身份共享锁 → task 行锁。进入执行对象后统一为 task → attempt → step（多个按 ordinal）→ authorization → task budget；后续存储记录在其父记录后处理。工作进程不回头申请人工命令的前置锁，也不允许锁住子对象后再首次锁 task。数据库触发器再取父锁时，调用方已持有父锁。

所有新路径需一并复核停止、终止、过期清理及现有预算函数的锁序。尤其当前 `admitControlledCall()` 只按 attempt 查一条 running step；原生分派期间可能同时有 Supervisor 与 Research 步骤，后续必须改为明确 stepId 并校验归属，不能无序命中任一 running step。

共用流程：

1. HTTP 会话/Origin/CSRF/角色检查；校验严格请求结构并生成规范指纹。
2. 事务内设置短锁等待/语句超时，取幂等锁及身份/任务锁，再查任务、账号与成员归属。生产时间使用数据库时钟。
3. 优先检查已完成的同键记录：同指纹返回原 202/响应；不同指纹返回 `409 IDEMPOTENCY_KEY_REUSED`。重放前仍要确认当前访问权限，不能把旧响应给已被移出团队的成员。
4. 新动作才检查 revision、生命周期、发布锁、当前 attempt/generation、取消和端点前置状态；锁内读取榜单、选择、最新报告、待用授权与预算。
5. 原子写入该端点的所有业务对象、一次 task revision 递增、审计及完整幂等响应；提交后返回。

幂等作用域沿用 team/actor/method/规范路径；指纹包括所有请求字段和业务前提。集合型 questionIds/gapIds 排序后编码；材料保留正文原始字节、clientRef 与原次序；官网规范化为 origin/path 配对后编码。JSON 字段排序固定，不用普通对象构造顺序决定指纹。非法或重复 ID 不静默去重。幂等键保留至少 24 小时，成功记录与业务写入同事务，验证失败不消费键。

换键不等于新权限：选题永久唯一、每 attempt initial 授权唯一、每 attempt 待用授权唯一、task 当前工作槽唯一、补查基版必须最新。旧响应失效或键过期后先 GET；不能通过换键自动补一次研究。不同成员的点击虽然不共享幂等作用域，仍由 task 行锁、revision 和业务约束防重。

锁超时/死锁导致的事务整体回滚返回可重试的 `503 DEPENDENCY_UNAVAILABLE`，客户端复用同键；不能在超时后继续执行模型调用。提交结果不明时也按同键重查，不猜测失败另造动作。约束错误按已知业务约束映射为 409/423，不泄露 SQL，也不吞掉未知错误。

## 6. 三个命令的具体写入顺序

### 6.1 选题＋授权

在共用模板锁内完成：

1. 复核当前等待选题 attempt、其唯一榜单及候选；从候选生成完整 `SelectedProject`，分配 selectionId/authorizationId。
2. 插入 `project_selections`；插入同 attempt 的 initial 未消耗 `research_authorizations`，scope 首轮官网列表为空。
3. 追加一条 queued Supervisor step，ordinal 取同 attempt 的最后值加一；不提前创建 running Research 或消耗授权。
4. attempt 与 task 改为 queued，`next_run_at` 设为可调度时间；清除等待信息，保持同一 currentAttemptId/generation。`active_since` 仍为空，活动计时从领取工作时开始。
5. revision 加一，写 `research.project_selected_and_authorized` 审计和幂等响应。任一步失败，选题和授权都不存在。

### 6.2 新 attempt＋新授权

1. 锁定当前已结束 attempt、读取任务唯一选题及原榜单；复核无活动工作、取消传播已完成隔离、预算/运行配置可用。
2. 新 attemptNo 加一，generation 取 task.workGeneration 加一；冻结新运行配置，插入 queued agent attempt，报告链为空。
3. 在事务内更新 task.currentAttemptId/workGeneration 指向新 attempt。**必须先做此步再插入新授权**，因为 `research_live_attempt_v14()` 要求授权属于 task 当前开放 attempt；事务内临时指针对其他事务不可见。
4. 插入引用原 selectionId 的新 initial 授权；只创建 Supervisor queued step，完全不创建 `github_hot` 步骤、不插入新榜单。
5. 原子失效旧批准、清空当前内容/审核资格指针，保留历史对象；设置 task/attempt queued、无租约，revision 加一。任务预算行只锁定读取，禁止删除、重建或归零。
6. 写 `research.attempt_retried_and_authorized` 审计与幂等响应；任何失败回滚新 attempt、指针、批准失效和授权，不留下无授权的新执行。

旧授权仍保留其原 consumed 状态。未消耗但所属 attempt 已结束的授权通过实时归属校验失效，不能为了释放唯一约束而伪造 consumedAt；待用唯一索引按 attempt 划分，不阻塞新 attempt。

### 6.3 资料＋补查授权

1. 锁定当前等待 attempt 与最新采用报告；核对 baseResultId、questionIds/gapIds、没有待用授权，读取待确认的精确材料版本。
2. 预分配 submission、authorization、source/material ID 和新版本，形成不可变 scope。即使 materials 和确认数组都为空，也保留一条提交批次，记录本次选中问题及单轮访问范围。
3. 插入 supplement 待用授权；插入绑定该授权的 submission、材料版本和确认事件。此顺序符合下节提交批次到授权的即时外键；scope 中预分配的材料引用在提交前统一核对。
4. 追加 Supervisor queued step，把 attempt/task 从等待态改为 queued，保留同一 generation，清除上一轮待创作交接的当前资格，但保留完整旧决定与报告。
5. revision 加一，写 `research.materials_submitted_and_authorized` 审计及幂等响应。提交阶段不覆盖旧 registry，也不创建假 running Research。

## 7. 补充资料的持久化缺口与新增迁移要求

当前 `research_registries` 要求已有已消耗授权及 running Research step，不能充当等待期间的资料箱。`task.referenceInputs`、审计正文、前端缓存和临时本地文件也不能替代持久化提交记录。建议新增两个不可变业务表：

| 表                              | 核心字段与约束                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research_submissions`          | UUID；task/attempt/authorization、baseResultId、questionIds/gapIds、官方范围规范快照、submittedBy/At。authorizationId 唯一且为 supplement；复合外键绑定同 task/attempt 授权及基版报告。允许零材料；提交时要求当前等待 attempt、授权未消耗。                                                                                                                                          |
| `research_submission_materials` | UUID 记录主键、submissionId、task/attempt、sourceId、materialId/version、lineageRootMaterialId、原文或线索链接、内容哈希、材料性质、可空旧材料版本引用、可空确认人/时间/确认版本。submission 外键带同 task/attempt；materialId 为每个快照唯一 ID，`(taskId, lineageRootMaterialId, version)` 唯一；正文/身份/版本/确认不可更新或删除。纯链接仅保存来源线索，不生成 materialId/版本。 |

每次新文本材料初始 version=1、lineageRootMaterialId=materialId；已有材料新增确认时分配新快照 materialId，沿用谱系根、增加版本并引用基版中的确切旧版本，不更改旧材料行。已有历史材料无谱系记录时以原 materialId 为谱系根。既有来自 registry/完整报告的材料还没有关系表外键，因此旧版存在性与哈希由锁内业务校验，不能把 JSON 中的字符串当作已建立数据库外键。共享校验禁止伪造 source/material ID、版本冲突、确认人越团队及 source 性质升级。新版报告保留旧材料快照及其证据，新确认材料通过新 ID 被引用。

仅链接的记录没有正文材料，保留 source 线索；首次实际抓取后再创建真实网页材料，不沿用对用户文本的确认冒充抓取内容。正文 SHA-256 按保留的 UTF-8 原文计算，证据摘录仍按共享契约使用正文 UTF-16 偏移。

新表 INSERT 需通过 live-attempt/active-member 护栏，UPDATE/DELETE 一律拒绝。应用事务另校验 scope.materialRefs 与实际提交集合完全一致、submission 到 authorization 一一对应；后续迁移须评审是否增加提交时完整性触发器。scope 不能引用尚未成功提交的资料。授权、提交记录、材料版本和确认同事务，避免多余的双向即时外键形成插入环。

迁移还需给 `research_registries` 增加非负 `registry_revision`（已有记录默认 0，新协议第一次写入为 1），用于私有登记接口的比较更新。材料表应约束两种记录形态：有文本时 materialId/谱系根/version/内容哈希齐全；只有链接时这些正文材料字段及确认均为空。确认字段必须成组存在且确认版本等于当前快照版本。运行期间 registry 更新只能扩展真实记录或将 running 调用转为终态，不能删除历史证据或回退终态；这些跨 JSON 规则由共享校验与登记服务共同执行。

后续执行器把这些不可变提交记录转换为现有 `ResearchSource/ResearchMaterial` 和 `firstHandConfirmation`，在研究轮启动后纳入该轮 registry，并保留“用户提供，未经外部独立核验”。视频和文件资产表本批不新增写入。

## 8. 实际分派时消耗授权

HTTP 命令只创建待用授权。Supervisor 原生 `Agent(research)` 工具真正准备执行时，`claimAuthorization` 才进入后端事务：

1. 私有 Agent 服务请求必须绑定当前 runId、executorId、claimToken、generation、父 SDK 会话和原生 toolUseId。后端锁 task/attempt/父步骤，重新核对当前身份、running、未取消、数据库租约未过期及父调用未过 deadline；浏览器 Session 不能代替工作进程执行权。
2. 解析原生 prompt 中的 ResearchRequest，校验 Skill/工具版本、scope、补查基版仍为最新、所有材料确认及来源范围。格式不合法、越权或资源准入失败不消耗授权。
3. 锁授权并检查未消耗；用宿主预分配的 Research stepId 建立唯一子步骤，绑定同授权和父 Supervisor，冻结最终 ResearchContext/inputSnapshotId；先建立 running 子步骤，再条件更新授权 `WHERE consumed_at IS NULL`，写 consumedAt/consumedByStepId，必须恰好更新一行。子步骤 ID 在构建 Supervisor 输入的 `researchContext.inputs.stepId` 时已生成并保存在父步骤冻结输入中，claim 不能另外换一个 ID；inputSnapshotId 沿用同会话快照，符合现有 buildResearchContext。
4. 资源预占必须已覆盖当前 SDK 主会话及本次子 Agent 树，预算行锁内复核；将子步骤、授权消耗与分派身份记录同事务提交。事务失败不开始 Research。
5. 提交后才允许此原生工具继续进入命名 Research；逐次工具准入重查实时执行权、授权对应步骤、scope、剩余额度和 deadline。

这只提供**授权最多消耗一次和保守的最多一次分派准入**，数据库与远端 SDK 不存在共同事务，不能承诺远端恰好执行一次。消耗事务提交后、SDK 真正开始前崩溃时，保留已消耗事实并记录分派不确定/执行失败，结束 attempt；不因“可能没调用”恢复授权。租约过期的 running 工作不重新排队，继续沿用人工新 attempt＋新授权规则。

同一分派身份的私有 HTTP 重传可以读取原消耗回执，但回执不是第二次启动许可。必须复用同一已登记 run/会话/toolUseId；服务重启、原调用状态不明、响应丢失时停止并按失败处理，不能重新创建 SDK query。其他步骤、其他 toolUseId 或其他进程再次消费同授权，一律拒绝。实际 API 或传输层应区分“读取已登记回执”与“首次准入”，不能把同键成功简单解释成可以再次执行工具。

Supervisor 选择继续澄清时不走本流程。全量答复后追加同 attempt Supervisor 并重新判断，待用授权保持一份，不再抓榜、不另建授权；澄清未通过也不自动研究。

### 8.1 独立 Agent 服务的私有接口

当前 `/internal/v1/agent-runs/check` 只核对父运行，不能让远端服务自行消费数据库授权。建议新增下列后端私有接口，路径不带 `/api/v1`，均沿用现有 service Bearer 认证；凭据和 lease 不进入模型 Prompt、浏览器 DTO 或普通日志。协议新增严格 Schema，缺失能力时拒绝 Research，不回退到内存授权。

共用请求身份为 `{ protocolVersion, runId, lease, execution, researchExecution, authorizationId, sdkSessionId, dispatchToolUseId }`：execution 为父 Supervisor，researchExecution 为宿主预分配的子步骤，dispatchToolUseId 为原生 Agent 分派 ID，所有 ID/快照相互核对。SDK 会话初始化完成前不能准入分派；会话 ID 由宿主实际事件登记，不能仅凭模型返回值信任。补充载荷如下：

| 私有 POST 路径                          | 载荷及提交语义                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/internal/v1/research/claims`          | 最终 ResearchContext 与 contextHash；按第 8 节原子建立子步骤并消耗授权。首次返回 201，完全相同身份/内容的回执读取返回 200/replayed，异身份或异内容 409；重放回执不允许新建 SDK 会话。                                                                     |
| `/internal/v1/research/tool-admissions` | 实际 Research agentId、子工具 toolUseId、toolName、工具请求与请求哈希；校验 agentId 确由本分派产生，在出站前实时校验 scope/身份/额度并持久化调用准入。返回一次性 admissionId；同 toolUseId 的重传读取原状态，不能另发一次出站请求，未知执行状态保守终止。 |
| `/internal/v1/research/registries`      | 单调递增 registryRevision、完整快照、snapshotHash；校验同授权/步骤及真实登记来源后持久化。旧 revision 不覆盖新快照，同 revision 异哈希拒绝，步骤终态后不更新。registryRevision 须通过新增迁移持久化，不能只靠服务内计数。                                 |
| `/internal/v1/research/results`         | 固定 resultId、resultHash、候选完整结果与最终 registry；全校验后按第 9 节同事务采用。首次 201，同结果内容只读重放 200，异内容/基版 409。                                                                                                                  |

正文和材料不能因来自已认证服务就跳过共享语义校验；服务身份只证明调用者，材料真实性仍依赖实际出站/内容登记适配器。工具准入计数与最终调用记录必须可对账。若采用后端受控出站读取，准入与执行由同一持久调用 ID 贯通；不能让 RPC 重传重新执行工具。

结果已提交而回执丢失时，可在验证服务身份和任务归属后读取同身份/同哈希的已完成结果，即使 attempt 随后进入等待或结束也不重新采用。任何新写入仍须有效 lease。claim 的状态重放同样只给历史回执，必须明确标为不可重新执行。私有鉴权失败返回 401，执行权或内容冲突返回 409，依赖不可用返回 503；均 no-store，不返回数据库内部错误。

## 9. 报告提交、等待与失败

报告候选必须在任何“已采用”写入前完成结构、真实来源/正文、证据偏移、问题范围、六章、三平台本轮搜索记录、Prompt/Skill 版本和历史变更校验。当前 `createResearchIntegration().acceptResult` 是先调用外部适配器再做部分校验，后续应拆为“构建候选 → 全部校验 → 提交”，或把全部同等校验放进持久化适配器；不能先提交报告再指望外围校验回滚。

接收事务锁 task/attempt/相关步骤/授权，复核租约 token/generation/取消和最新基版后：

1. 先保存本轮最终真实 registry（含提交资料、历史证据与新增内容）；同轮调用/材料记录可在运行中分批保存，终结前必须齐全。
2. initial 报告生成本 attempt 的版本 1；supplement 输出完整新报告，parentResultId=本授权 baseResultId，version=基版加一。保留旧 sources/materials/evidence，新增/修正/撤回和缺口变化可追溯。
3. 保存校验后的完整 ResearchAcceptedResult 及结果投影，结束 Research 步骤，写审计；全部同事务。失败不出现已采用但缺登记的报告，迟到/旧代次不能采用。

Research 报告采用与 Supervisor 最终决定是两个阶段：报告可先持久化，再供同会话 Supervisor 判断；只有最新结果能参与后续交接。若最终 Supervisor 失败，已采用报告作为失败 attempt 的历史保留，但 task 不进入待创作，下一 attempt 仍从版本 1 开始。重复提交同一结果 ID/版本/哈希只返回原结果；同 ID 不同内容拒绝，不能覆盖终态步骤。

Supervisor 结果另以事务保存最终决定、结算并终结父会话调用，再切换 task/attempt：`needs_clarification → awaiting_clarification`、`needs_materials → awaiting_materials`、`ready_for_content → awaiting_content`。等待时原子暂停活动计时，清空 executor/claim/lease、active_since、next_run_at，finished_at 为空，仍保留活跃工作槽，不遗留 running call。只有领取 queued 后恢复计时。

核心证据缺口必须阻断创作；非关键缺口逐项排除说法并保留警告才可待创作。单个工具失败、无结果或合法 partial 报告不直接结束 attempt；无法交付有效报告、会话中断、超时或宿主权限故障则结束 failed/cancelled，隔离后续工具与迟到写入，不自动追加研究轮次。

## 10. 任务累计预算与 SDK 调用树

沿用一任务一条 `task_execution_budgets`，**不按 attempt、授权或报告版本新建预算**。本次确认的任务模型估算费用上限为 1 元，即 `1_000_000 microCNY`；initial、supplement、人工重试、Supervisor 和格式纠正均进入同一任务账本。已冻结历史预算不自动改写，新重试也不能重置。价格版本、输入/输出单价、美元 SDK 上限仍待配置确认，本设计不填入猜测值，也不启动真实请求。

为兼容当前每 step 最多一条 running call 的约束，首批建议使用**一次 Supervisor SDK 会话一条模型预占记录**：

- 父会话 `task_execution_calls` 绑定 Supervisor step，预占覆盖父模型、原生 Research 子 Agent 和本会话内有限格式纠正的整棵调用树；Research 子步骤不再为同一份模型用量新增一笔收费。
- Research 的逻辑步骤、toolUseId、网页调用和材料保留在步骤元数据/registry 中，关联 parent call/runId。子 Agent 的授权在子步骤绑定，父会话创建时 authorizationId 可以为空；不能为了追踪子工具重复开一份等额预占。
- `maxCalls` 在此模型下统计宿主准入的 SDK 会话，逐轮搜索/读取另按网页配额计数；不把会话次数冒充供应商内部模型请求次数。需要真正逐模型请求硬限制时须先增加可观测准入能力。
- 按稳定会话身份只结算一次，先占后结；使用唯一、不重叠的模型用量统计。只有明确证明未使用的预占才释放，超时/崩溃/未知消耗保守保留，重复回调不能重复收费或退款。
- 单个会话内部原生工具/独立正文读取不另计同份模型 tokens；如果供应商另收搜索或读取费用，必须有单独收费项和价格依据纳入预算，不能因模型账本已有记录就声称工具免费。未知费用不能登记为真实零费用。

宿主在会话启动前锁 task budget 预占，分派时验证其已覆盖本轮，后续每个受限工具仍检查实时额度。剩余额度不足时拒绝新运行，不自动提高预算。若 SDK 真实消耗超过预占，保留实际估算与超额错误、停止后续调用，不能截断账本伪造在限额内；估算上限不是供应商账单的绝对保证。

这是首批账本映射方案，后续必须以锁定 SDK 的实际用量统计做离线契约验证；无法证明父子用量不重复或无法约束未定价调用时，不开启真实 Research。独立纠正会话若确有必要，须串行新准入、独立预占和结算，仍使用任务剩余预算，不能重新分派 Research 或重新搜索。

## 11. 查询、页面与冲突恢复

建议新增只读接口，沿用同团队访问检查、no-store 和不含凭据的 DTO：

| operationId / 路径                                                                         | 返回范围                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `taskResearchState` / `GET /tasks/:taskId/research`                                        | 当前选择、原榜单来源、当前 attempt、最新报告 ID/版本、待用/已消耗授权摘要、提交批次摘要和 actions |
| `taskResearchReports` / `GET /tasks/:taskId/research-reports?attemptId=…&cursor=…&limit=…` | 单 attempt 报告版本摘要与父关系，分页；旧 attempt 仅历史查看                                      |
| `taskResearchReport` / `GET /tasks/:taskId/research-reports/:resultId`                     | 指定完整报告、来源/实际材料、确认、警告与变更，核对 task 归属                                     |
| `taskResearchSubmission` / `GET /tasks/:taskId/research-submissions/:submissionId`         | 已提交的问题、资料版本、一手确认及该轮官网访问范围                                                |

当前热榜读取按选题引用回溯原始 snapshot，不能假定新 attempt 拥有自己的榜单行。task 详情只给摘要，不把整个报告链/原始响应塞入每次轮询。原始榜单和完整 registry 是后端回查资料，不默认整体传给模型或写日志。

页面三个按钮均是明确授权动作，单次点击生成一个幂等键，网络重传复用。补查必须勾选当前报告的问题；无资料仍能提交。官网范围每轮重新列出确认，一手确认与实际文本版本绑定。提交后显示“已排队／授权待用”，实际分派后才显示“已消耗”；不能把 202 文案写成“研究成功”。

| 错误                                    | 页面处理                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `400 VALIDATION_ERROR`                  | 标记字段/范围错误；未保存任何部分资料，不自动重传                                                     |
| `401/403/404`                           | 重新登录或提示不可访问；不展示旧幂等响应                                                              |
| `409 REVISION_CONFLICT`                 | 保留本地草稿，读取最新 task；不自动用新 revision 再提交                                               |
| `409 INVALID_STATE`                     | 用字段信息说明旧榜单、报告基版、已选题、已有待用授权或 attempt 已变化；刷新当前状态，由用户确认新动作 |
| `409 IDEMPOTENCY_KEY_REUSED`            | 停止提交并提示动作标识冲突，不自动换键执行                                                            |
| `423 WORK_LOCKED / PUBLICATION_LOCKED`  | 展示当前占用原因，等待或使用已提供的停止动作，不抢占                                                  |
| `503 DEPENDENCY_UNAVAILABLE` / 网络未知 | 保留同键及草稿，重查或同键重试；不凭新键补一次操作                                                    |

错误结构沿用现有 ApiError；报告/授权等细分原因使用明确 message/fieldErrors，不在文档中悄悄扩展 ErrorCode。revision 冲突填现有 conflict 的最新 revision 和 taskUrl；报告基版冲突指向 `baseResultId` 字段并提示重新读取报告。审计记录动作、actor、task/attempt/selection/authorization/submission、基版、scope 哈希及 requestId，不复制材料全文、凭据或模型内部推理。

## 12. 后续实施与验收用例

实施顺序：共享请求/响应及 scope → 新增资料存储迁移和事务服务 → 三个命令及查询接口 → 分派消耗/登记/校验提交适配器 → 页面。共享操作进入 `shared/src/contracts.ts`，响应进入共享响应映射，再生成请求类型、响应 Schema 和 api-reference；不直接手改 generated 文件。真实执行器先去掉当前选题后 `RESEARCH_NOT_ENABLED` 的阻断分支，并补齐本设计的控制，不能只删除拦截就宣称 Research 已可用。

后续以临时数据库、离线 transport 和固定登记资料覆盖下列用例；本轮仅列验收方案，**未执行这些测试，也未授权新迁移或真实联网验收**。

| 编号  | 必须验证的行为                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------ |
| TX-01 | 选题后注入授权/排队/审计/幂等写入故障：选题与其他新增对象全部回滚。                              |
| TX-02 | 新 attempt 插入、task 指针更新、新授权、批准失效任一处失败：全部恢复原 attempt/指针/批准事实。   |
| TX-03 | 补交任一资料或确认失败：无 submission、材料或新授权；零资料但合法问题和显式授权成功。            |
| TX-04 | 同键同请求并发/响应丢失重传只返回同一授权；同键异请求 409；权限撤销后不重放旧结果。              |
| TX-05 | 不同键/不同成员并发选同一或不同候选仅一方成功；不会出现第二选择、第二待用授权。                  |
| TX-06 | 两次补查同基版仅接受一次；旧 revision、旧报告、越 attempt 的问题/材料/确认全拒绝。               |
| TX-07 | retry 沿用原榜单/选题且零抓榜调用，报告版本从 1 起，旧报告和授权不变，预算不归零。               |
| TX-08 | 新 attempt 授权插入顺序通过 0014 live guard；回滚不会使调度器领取临时新 attempt。                |
| TX-09 | Supervisor 继续澄清不消耗授权，答复后仍同 attempt、同授权；新增越权要求不能扩权。                |
| TX-10 | 两进程/不同原生 toolUseId 同时 claim，仅一次消耗/分派准入；running 步骤选择必须明确 stepId。     |
| TX-11 | 消耗提交后崩溃、私有回执丢失、租约失效均不恢复授权或自动重开 SDK；旧 token 迟到工具/结果被拒绝。 |
| TX-12 | 停止/终止与选题、补交、claim、报告采用并发：task 锁与 generation 确定唯一顺序，无停止后新写入。  |
| TX-13 | 粘贴材料正文、模型输出或 README 外链不能赋予一手确认、官网权限或通用工具能力。                   |
| TX-14 | 一手确认绑定实际用户、时间、材料版本/哈希；修改文本须新版本重确认；仅链接不生成虚假正文。        |
| TX-15 | `/docs/` 可读子路径，`/docs-old`、`/blog/`、其他域名及跨范围跳转拒绝；下一轮默认无官网 grant。   |
| TX-16 | 三平台本轮搜索记录、真实正文、六章、证据偏移和历史变更均校验后才采用，校验失败无终态报告。       |
| TX-17 | 最终 registry 与报告事务中故障无半份已采用报告；同结果重复提交可读复用，异内容不能覆盖。         |
| TX-18 | partial/单工具失败可交付并保留缺口；核心缺口阻断、非关键排除有警告；失败结束 attempt。           |
| TX-19 | awaiting_content 保留 attempt、无租约/活动计时；补查排队清除旧交接资格，历史决定仍可查。         |
| TX-20 | 初次/补查/人工重试/格式纠正共用预算，父子会话无重复收费，未知费用保守预占，重复结算不改账。      |
| TX-21 | 提交后进程退出但调度仍能领取 queued；锁超时、键过期与提交结果未知不会创建第二轮研究。            |
| TX-22 | 未接线旧 agent retry 入口、跨团队读取、伪造确认人/策略字段、前端强行改 actions 均无法绕过后端。  |

数据库迁移、真实出站控制方案、模型计价及 SDK 美元限额确认、真实供应商联调是后续独立事项。本文完成接口与事务方案，不把这些未完成条件写成已实现能力。
