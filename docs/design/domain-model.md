# D1 核心对象设计

日期：2026-10-27。版本：0.1。本地设计初稿，待共同走查；不代表功能已实现或验收通过。

配套文档：[状态转换表](state-transitions.md)。需求依据：[PRD V1.0（核对版本 12f36ec）](https://github.com/a2440890770-max/multi-agent-ops/blob/12f36ec9432c920c4c8d5cdc9b5fd7f08ceb2cb5/docs/product/PRD-V1.0.md)。

## 1. 范围与依据

首期为一个内部团队、一个微博账号、普通微博纯文案、人工批准及手动发布。本文仅定义逻辑对象、关联和一致性约束，不定义 API、页面、数据库迁移或运行代码。

PRD 与本次确认有差异时，以已确认的业务规则为准。特别是 PRD 2.1、P1-P03 中的“批准后立即尝试发布”，在本设计中改为“批准与发布分开操作，批准后等待用户点击发布”，不支持定时发布。原 PRD 未被修改，后续合入仓库时需要同步。

### 1.1 已确认的 12 项业务规则

以下 R 编号沿用讨论中的顺序，不是新增需求。

| 编号 | 已确认规则                                                     | 对象落点                                     |
| ---- | -------------------------------------------------------------- | -------------------------------------------- |
| R01  | 失败重试保留同一任务，新建执行尝试，从研究开始执行，保留旧历史 | Task、ExecutionAttempt                       |
| R02  | 发布中或发布待核实时，禁止编辑和重新执行；核实结果前不重复发布 | Task、PublishOperation                       |
| R03  | 点击保存才创建新内容版本；保存成功使旧批准失效                 | ContentVersion、Approval                     |
| R04  | 保存后手动提交审核，不因保存自动调用审核                       | ReviewCycle、ContentVersion                  |
| R05  | 批准和发布是两个独立操作，发布时再次校验                       | Approval、PublishOperation                   |
| R06  | 审批、发布、复盘集中在任务详情中                               | 各对象通过 taskId 关联；页面实现不在本文范围 |
| R07  | 并发编辑时先保存者成功，后保存者收到冲突提示并保留输入         | Task.revision、ContentVersion                |
| R08  | 每次执行尝试累计最多三轮自动修改，人工编辑不清零               | ExecutionAttempt、RevisionRound              |
| R09  | 记忆删除无回收站；立即停止召回，后台清理并保留必要审计         | Memory、MemorySyncJob、AuditEvent            |
| R10  | 同一任务最多一个执行尝试运行，不能重复启动                     | TaskWorkSlot、ExecutionAttempt               |
| R11  | Agent 执行期间文案只读；先取消执行，确认停止后才能编辑         | ExecutionAttempt、TaskWorkSlot               |
| R12  | 成功发布后需要再创作或再次发布时，复制为新任务并关联原任务     | Task.sourceTaskId、PublishOperation          |

PRD 既有约束继续适用：审核与人工批准分离；确定性阻断不可绕过；候选经验不自动启用；模拟发布不计真实发布；角色权限在服务端验证。

### 1.2 为消除歧义采用的设计解释

- **停止本次执行**与**终止任务**分开：前者用于停止 Agent 后人工编辑，后者使任务进入终止状态并阻止后续发布。两者都必须记录意图和操作者。此区分用于同时满足 R11 和 PRD 的取消约束，不新增对外接口。
- 人工保存后的“提交审核”仅审查冻结的人工版本，不授权 Agent 自动重写该版本。未通过时返回人工处理；需要重新自动生成时，明确新建完整执行尝试。
- 自动生成链路中的 Review 与修改循环使用原尝试的三轮额度；人工提交审核、技术重试和服务重启都不能重置该计数。
- 发布结果明确、锁已释放后，仍按结果校验操作：成功只能复制新任务；失败才可能编辑、重新执行或人工重试。不能将“解锁”理解为所有操作均可执行。

## 2. 通用约定

- ID 为不透明唯一标识；具体 UUID 版本、字段长度和 SQL 类型留到物理模型设计。
- 时间以 UTC 保存，展示时转换时区；空时间表示该事件尚未发生。
- 引用必须属于同一团队和任务；平台账号还必须匹配批准记录。前端传入 ID 不能代替服务端检查。
- Task.revision 是并发控制号，区别于内容的 versionNo 和配置版本。任何影响编辑、审批、发布资格的变更都应更新它。
- 内容摘要由服务端对实际将发送的 UTF-8 文案计算，例如 SHA-256。禁止批准后静默变更空白、标点或正文；需要变换时先生成新版本并重新审核批准。
- 版本、审核结果、批准事实、已发生的外部调用和核实证据保留历史。允许以新事件更新状态，不覆盖旧事实。
- 记录显式输出、判断依据与摘要；不要求采集模型内部推理。对象不保存明文密钥和授权凭据。

## 3. 核心业务对象

### 3.1 Task：任务

| 字段                                                   | 含义与约束                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| id、teamId、accountId、createdBy、createdAt、updatedAt | 任务标识、归属、固定发布账号及创建信息                                    |
| originalRequest、clarifications、referenceInputs       | 原始要求、澄清答复及参考资料；修改要求保留历史                            |
| lifecycle                                              | open / terminated / published；用于管理任务终止和发布终结，不替代四类状态 |
| currentAttemptId                                       | 当前完整执行尝试；历史尝试继续可查                                        |
| currentContentVersionId                                | 当前工作版本；不将旧尝试内容静默当成新产出                                |
| currentReviewCycleId、currentApprovalId                | 当前版本适用的审核周期及批准引用，可为空                                  |
| activePublishOperationId、publishedOperationId         | 未决实际发布操作、最终成功发布操作，可为空                                |
| sourceTaskId                                           | 复制来源；新任务不得继承旧批准或发布资格                                  |
| revision                                               | 并发校验号，写入时比较并原子递增                                          |
| terminatedBy、terminatedAt、terminationReason          | 任务终止记录；与停止一次执行不同                                          |

不将 execution、approval、publication、reflection 合并成一个“大状态”。任务详情分别读取相关对象的状态。

### 3.2 ExecutionAttempt：完整执行尝试

| 字段                                                            | 含义与约束                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| id、taskId、attemptNo、requestedBy、createdAt                   | 同一任务多次尝试，attemptNo 单调递增                                         |
| status、currentStep                                             | 执行状态及步骤；状态集合见配套文档                                           |
| requestSnapshot、configSnapshot                                 | 本次输入、账号规则、角色、模型、提示词和工具版本等配置快照；不得包含明文密钥 |
| autoRevisionCount                                               | 0—3，初稿不计；人工编辑不改变，只有新尝试从 0 开始                           |
| cancelScope、cancelRequestedBy、cancelRequestedAt、cancelReason | 停止执行或终止任务的取消意图                                                 |
| stoppedAt、startedAt、finishedAt                                | 已停止确认与起止时间；取消请求不等于已经停止                                 |
| error、interruptionReason、traceRef                             | 失败原因、中断原因和可用的轨迹引用                                           |

新尝试始终从头执行。启动时原批准失效、当前审核引用清空；旧版本仍在历史中，当前版本指针清空，待新产出生成。新尝试不得自动触发实际发布。

### 3.3 ContentVersion：不可变内容版本

字段：id、taskId、originAttemptId（可空）、parentVersionId（可空）、versionNo、body、contentHash、createdBy、createdAt、sourceKind（agent / manual）、revisionRoundId（可空）、sourceRefs、usedMemoryRefs。

- versionNo 在任务内单调递增；originAttemptId 用于来源及额度归属，不因人工编辑而制造一次新执行。
- body、contentHash、父版本及来源创建后不可原地改写；保存产生新记录。未保存的输入不进入版本历史。
- 保存必须同时比较 Task.revision 和当前版本 ID；发生冲突整次保存拒绝，不创建孤立“成功版本”。保留用户输入由后续客户端完成。
- 人工或 Agent 新版本成为当前版本时，均清空当前审核资格，并使此前有效批准失效。

### 3.4 ReviewCycle / ReviewRecord / RevisionRound：审核与自动修改

| 对象           | 最低字段与用途                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReviewCycle    | id、taskId、attemptId（可空）、trigger（initial_generation / manual_submit）、inputVersionId、currentVersionId、status、requestedBy、configSnapshot、createdAt、finishedAt、error；表示一次受控审核周期 |
| ReviewRecord   | id、cycleId、contentVersionId、outcome（pass / changes_required / manual_required）、checks、blockingIssues、scores、scoreSources、sources、reviewerRef、createdAt；冻结某版审核结论                    |
| RevisionRound  | id、attemptId、roundNo（1—3）、inputVersionId、reviewRecordId、status、outputVersionId（可空）、error、createdAt；一轮自动修改及其结果                                                                  |
| ManualDecision | id、reviewRecordId、actorId、reason、acceptedIssues、unresolvedIssues、evidenceRefs、createdAt；记录主观分歧裁决，不能清除确定性阻断                                                                    |

审核周期状态：queued / running / completed / failed / cancelled。结果与运行状态分开，completed 不代表通过。人工周期可关联已停止尝试作为来源，但不会恢复它或重置其额度。

自动修改在调度前，原子预留 roundNo 并递增 autoRevisionCount；唯一键为 (attemptId, roundNo)。同一轮的有限技术重试复用该记录，不再次计数；已预留但失败的轮次不退还，避免通过失败或重启无限重写。每次修改形成新内容版本并重新审核。

### 3.5 Approval：发布批准

字段：id、taskId、contentVersionId、contentHash、accountId、reviewCycleId、status（approved / invalidated）、approvedBy、approvedAt、invalidatedAt、invalidatedReason。

“未申请”和“待批准”是当前版本的审批流程投影；实际批准后才创建 Approval 事实记录。当前有效批准最多一条。重复批准同一版本应返回已有有效记录；失效记录不能重新改成有效，新批准创建新记录。

批准前校验：权限、任务开放、当前稳定版本、审核通过或合法主观裁决、无确定性阻断、无执行和发布锁。发布前再次核对相同条件，并核对账号授权。账号授权失效时，即使批准记录尚在也不能发布。

### 3.6 PublishOperation / PublishDispatch / VerificationRecord：发布与核实

| 对象               | 最低字段与用途                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PublishOperation   | id、taskId、contentVersionId、contentHash、accountId、status、currentDispatchId、createdBy、createdAt、updatedAt；一次实际发布意图的稳定标识                                                     |
| PublishDispatch    | id、operationId、dispatchNo、approvalId、channel（official_api / manual）、status、startedBy、startedAt、finishedAt、providerRequestId、platformPostId、url、error；每次获准的外部发送或人工交接 |
| VerificationRecord | id、operationId、dispatchId、actorId、method、conclusion（published / not_published / unknown）、platformPostId、url、evidenceRefs、observedContentHash、mismatchNote、createdAt；追加核实证据   |

- 实际发布操作以 (taskId, contentVersionId, accountId) 唯一，重复点击复用该操作。不是每个 HTTP 请求都新建实际发布操作。
- 仅在明确失败或核实未发布后，用户显式重试才创建新的 PublishDispatch；同一操作的 dispatchNo 单调递增，历史不可覆盖。待核实不能新增发送。
- 新发送绑定当时有效的 Approval；不得重用失效批准。编辑产生新版本后，原操作只能保留历史，不能再发送旧版本。
- 同一任务最多一个实际发布操作处于人工交接、发送或待核实阶段；成功后 Task.lifecycle 变为 published，阻止任何后续实际发送。
- 人工交接也冻结批准版本并持有发布锁；回填核对账号、版本和链接，差异显式记录，不能用回填把不一致内容标记为批准版本的成功。
- 模拟发布单独保存为 SimulationRecord 或测试夹具，不更新实际发布操作的成功状态、Task.publishedOperationId 或真实发布验收结果。

### 3.7 Memory / MemorySyncJob：记忆及清理

Memory 字段：id、teamId、accountId、type、body、version、status、scope、sourceTaskId、sourceVersionId、sourceReflectionId、evidenceRefs、confirmedBy、confirmedAt、confirmationReason、syncStatus、externalMemoryRefs、deletedAt、createdAt、updatedAt。

- type 区分账号偏好、任务事实、候选经验、已确认经验；工作上下文按任务隔离，不默认升级为长期记忆。
- status 为 active / disabled / deleted。候选可 active，但 active 仅表示未禁用，不表示允许用于正式创作。
- 检索同时按团队、账号、用途、类型和状态过滤，并用业务库当前版本复核结果。候选仅供复盘及实验；明确任务要求优先于历史偏好。
- 明确人工确认才允许创建带确认人、依据及范围的已确认经验，保留来源候选；不通过直接改 active 或模型总结自动升级正式策略。
- 删除先在业务库置 deleted，递增版本并写清理任务，立即阻断召回；物理清理随后执行，不提供恢复操作。

MemorySyncJob 字段：id、memoryId、targetVersion、action、status（pending / running / succeeded / failed）、externalRefs、attemptCount、lastError、createdAt、finishedAt。旧版本同步不能覆盖新版本或复活已删除记忆；删除失败保留可见状态，成功前不宣称全部副本已清除。

### 3.8 Reflection：复盘

字段：id、taskId、attemptId、retryOfReflectionId、status（processing / completed / failed）、requestedBy、inputSnapshotRefs、evidenceRefs、observations、hypotheses、alternativeExplanations、suggestedValidation、uncertainties、candidateMemoryIds、error、createdAt、finishedAt。

未触发表示没有复盘记录。已结束的执行或发布结果可手动复盘；输入冻结具体版本及证据。不自动改提示词、正式策略、工具权限和原发布结果。失败重试新建记录并关联旧记录，避免覆盖旧失败。

### 3.9 TaskWorkSlot / AgentStep / AuditEvent：一致性与追溯

| 对象         | 最低字段与约束                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TaskWorkSlot | taskId、ownerType（attempt / manual_review）、ownerId、generation、leaseExpiresAt；同任务唯一，用于跨生成和人工审核互斥；过期先确认中断并隔离旧执行器，再释放                                   |
| AgentStep    | id、attemptId、reviewCycleId（可空）、role、status、inputVersionRefs、outputVersionRefs、sourceRefs、usedMemoryRefs、duration、error、traceRef；保存显式交接及来源，不保存内部推理              |
| AuditEvent   | id、teamId、taskId（可空）、actorType、actorId、action、targetType、targetId、beforeRevision、afterRevision、outcome、reason、evidenceRefs、createdAt；最小必要审计，不复制密钥或已删除记忆正文 |

TaskWorkSlot 是逻辑互斥约束，不指定必须创建同名数据库表。可用锁、唯一约束和租约实现，但仅依赖进程内变量不足以保证并发安全。旧 generation 的延迟结果不能更新当前版本、批准或任务状态。

团队成员、平台账号、配置版本作为关联基础对象沿用 PRD：保存角色和状态、授权状态及凭据安全引用，敏感凭据仅由后端集成使用。具体鉴权及供应商配置不在本文展开。

## 4. 关系与唯一性

| 关系／约束                                                            | 要求                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| Task → ExecutionAttempt、ContentVersion、Reflection、PublishOperation | 一对多，全部保留 taskId                               |
| ReviewCycle → ReviewRecord → ContentVersion                           | 周期包含审核记录，每条审核结论只针对一个不可变版本    |
| Approval → ContentVersion、账号、审核周期                             | 同时绑定，不能跨版本或跨账号复用                      |
| PublishOperation → PublishDispatch → VerificationRecord               | 一对多追加历史；同操作最多一个未决发送                |
| (taskId, attemptNo)、(taskId, versionNo)、(attemptId, roundNo)        | 各自唯一                                              |
| (taskId, contentVersionId, accountId)                                 | 实际发布操作唯一，手动与 API 共享防重边界             |
| 当前有效批准、任务工作槽、未决实际发布操作                            | 各任务最多一个；必须支持并发下的原子校验              |
| sourceTaskId                                                          | 引用同团队原任务；新任务使用新 ID，批准和发布引用为空 |

## 5. 原子边界与故障处理

1. **保存文案**：锁定／比较任务版本与当前内容 → 校验无工作及发布锁、任务未终止或发布 → 插入新版本 → 更新当前指针 → 失效旧批准、清空审核资格 → 增加 revision → 写审计，一起提交。任何一步失败整体回滚。
2. **新建执行**：校验任务可运行及发布锁 → 取得工作槽 → 失效旧批准并清空当前内容／审核指针 → 创建尝试和配置快照 → 增加 revision，一起提交；真正工作在提交后运行。
3. **批准与发布互斥**：批准、保存、启动执行、终止任务、占用发布锁必须在同一任务的串行化边界检查。批准成功不能绕过稍后点击发布时的再次校验。
4. **实际发送**：先持久化操作、发送记录、版本／批准快照和发布锁，再做外部调用。外部调用不包在可回滚的长事务中；崩溃后按可能已发送处理，不能因没有成功回执而自动重发。
5. **记忆删除**：业务 tombstone、版本变更及清理意图先原子提交，再清理检索和其他受管副本；不能依赖索引先删除成功才停止业务召回。
6. **取消确认**：阻止调度新步骤，等待正在执行的步骤结束或隔离旧执行器；确认旧结果无法提交后释放工作槽。仅写 cancelRequestedAt 不解除编辑锁。

## 6. 三条关键时序与验收关联

| 场景           | 对象层面的证据                                                       | 对应 AC                    |
| -------------- | -------------------------------------------------------------------- | -------------------------- |
| 修改后批准失效 | 新版本、旧批准失效原因、任务 revision、旧版本发送被拒记录            | AC-05、AC-08               |
| 未知发布不重试 | 稳定操作 ID、未决发送、待核实状态、核实证据；未知期间无新发送        | AC-06、AC-07、AC-11、AC-14 |
| 候选不自动启用 | 复盘证据、候选类型、用途过滤、实际采用的记忆版本；无自动正式策略变更 | AC-09、AC-10、AC-12        |

## 7. 文档状态与待完成工作

- 12 项业务选择已确认；本文对字段、互斥、额度预留和取消语义的技术展开是设计初稿，尚未共同走查或实测。
- 尚未创建数据库迁移、共享类型、接口、页面或测试；不能据本文将 AC 或 D1 整体标为已验收。
- 保留期限、外部 Cloud 副本清理、核实查询能力、具体超时及重试次数沿用 PRD 待定项；不能用本地业务删除替代外部平台删除。
- 后续需要用配套状态表走查三条关键时序，并将测试矩阵、Issue 和里程碑单独落实。本次文件仅保存在本地，没有提交或推送到 GitHub。
