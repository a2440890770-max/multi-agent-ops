# D1 接口契约说明

版本 0.1，2026-10-27，供前后端及测试共同走查。范围：单团队、单微博账号、单条纯文案；批准后由用户另行点击发布，不支持定时发布。

## 交付与权威来源

- [核心对象设计](domain-model.md) 定义业务对象；[状态转换表](state-transitions.md) 定义合法转换。原始输入文件在本次入库时保留，其“尚未实现”段落描述来源文档形成时的状态。
- `shared/src/domain.ts` 定义 API 可见对象；内部请求/配置快照、租约详情和凭据不直接出现在 DTO。
- `shared/src/contracts.ts` 是方法、路径、请求校验、权限、状态条件、幂等、转换、审计及 AC 的单一操作目录。
- `shared/src/generated/request-models.ts` 从请求 Schema 自动生成 OperationBodies/Queries/Params/Responses，前后端均可按 operationId 导入类型。`shared/src/responses.ts` 是响应映射；响应 JSON Schema 从 TypeScript 自动生成，不另维护后端 DTO。字段必填性和 null 含义以生成的 OpenAPI 为准。
- [逐项接口参考](api-reference.md) 列出全部接口及字段。`GET /api/v1/openapi.json` 提供 OpenAPI 3.1 契约，`npm run contract:generate` 更新生成物，`npm run contract:check` 检查漂移。

**当前实际能力：** 保留健康/就绪接口；已实现登录、当前身份及退出的服务端 Session 接口并接通前端，配置与验收见[认证说明](../infra/auth.md)。业务路由统一校验会话、角色及写入 Origin/CSRF；未登录返回 `401`、角色越权返回 `403`。D4 已实现 `POST /api/v1/tasks`：原始要求、参考资料、创建人和团队持久化，团队已配置账号时自动绑定，未配置时 `task.accountId` 和 `account` 为 null，也可先创建草稿。任务、24 小时幂等记录及 `task.created` 审计同事务提交，成功返回 `201 TaskDetail`；创建不自动执行。`GET /api/v1/tasks/:taskId` 已实现同团队详情查询，返回当前数据库状态、原始要求、当前步骤及 `errorMessage`，未绑定账号正常返回；跨团队与不存在统一 404，读取无业务写入。`GET /api/v1/tasks` 已实现同团队历史、标题/编号搜索、状态 AND 筛选与稳定游标分页。前端 `/tasks`、`/tasks/new` 与 `/tasks/:taskId` 已接通这些接口，支持创建后跳转、刷新/重新打开、失败保留输入和同动作键手动重试。详见[任务接口说明](../infra/tasks.md)。模拟执行的启动、停止、从头重试和历史查询已实现，使用真实数据库保存尝试、步骤、模拟产出及状态流；支持同动作键确认重放与 revision 并发校验。澄清答复提交已接通，追加记录关联原任务、尝试、问题及成员；全部问题均非空答复后继续同一次模拟执行，部分答复继续暂停。其余业务处理仍返回 `501 NOT_IMPLEMENTED`，真实 Agent、输入语义检查和外部发送尚未实现，任务后续绑定接口也尚未实现；原样例详情单独位于 `/previews/tasks/:taskId`。下述其他业务幂等、审计、原子边界及异步恢复仍为后续实现契约。

## 通用 HTTP 与字段规则

前缀 `/api/v1`；JSON UTF-8；时间为 UTC ISO 8601，页面按用户时区展示。ID 不透明、大小写敏感，1—128 位 `[A-Za-z0-9_-]`；不得从 ID 推测团队归属。所有路径对象逐级验证同团队/任务/账号，跨团队按 404 返回。分页默认 20、最多 100，`nextCursor=null` 表示结束；游标包括过滤快照和排序位置，过滤改变须从第一页开始；无效游标 400。除任务另有约定，历史按创建时间及 ID 降序。

未列出的请求字段拒绝，避免客户端任意设置 status、createdBy、teamId、contentHash 或确认人。ID、操作者、时间、摘要由服务端生成/校验。`expectedRevision` 是读取时 Task.revision，正安全整数；`versionNo` 只用于显示；`expectedVersion` 是成员/记忆/配置/盲评对象版本。内容保存同时提交 `baseContentVersionId`，首次无版本必须显式为 null。空白正文拒绝；正文不自动 trim、替换标点或改换行。20000 字符是传输上限，不代表平台发文长度；平台约束通过可配置规则校验。

成功响应统一：

```json
{
  "data": { "id": "resource-id" },
  "meta": { "requestId": "request-id", "replayed": false }
}
```

201 表示已持久化新对象；202 仅表示接受处理/取消意图，不能当作执行停止或发布成功；200 为查询或同步操作结果。任务命令返回新的 TaskDetail（独立创建的审核/复盘等返回对应对象）；客户端不能自行推算 revision，须刷新详情。重放返回原状态码及原结果，并设置 replayed=true；若资源随后变化，额外 GET 读取当前事实。

## 认证和权限契约

登录选型以[最终七项技术选型](../architecture/stack-decisions.md)为准，使用内部成员账号/口令 + 服务端会话：安全密码哈希，限速，统一凭据错误。D3 已实现三个认证接口，无默认账号或开发绕过；成员须显式初始化。生产 HTTPS，Cookie `ops_session` 为 HttpOnly、Secure、SameSite=Lax；本地仅安全标志可按 localhost 环境调整。会话绝对时长 8 小时；登出立即撤销，当前成员状态和认证版本每次复核。登录校验 Origin；退出等写入需同源 Origin 和来自 `/auth/me` 的 `X-CSRF-Token`；业务路由均已接入上述检查，认证先于正文解析及参数校验。读取不产生业务变更。接口不返回口令、API 密钥、微博令牌或授权安全引用。

| 能力                                                   | 运营人员                 | 管理员 |
| ------------------------------------------------------ | ------------------------ | ------ |
| 同团队任务、版本、审核、批准、人工裁决、发布/回填/核实 | 允许（含批准自己的内容） | 允许   |
| 手动复盘、业务记忆治理、人工确认候选、离线评测与盲评   | 允许，记录依据与操作者   | 允许   |
| 成员管理、官方授权入口、完整基础配置查询/更新          | 禁止                     | 允许   |
| 明文凭据读取                                           | 不提供                   | 不提供 |

`/auth/me` 返回当前成员、权限、CSRF 和过期时间。操作始终由服务端校验角色及状态，前端 `actions` 仅作一致性展示提示。Langfuse 独立鉴权，业务角色不自动授予其权限。前端当前身份由 /auth/me 获取，不提供预览身份切换。

## 幂等、并发和原子边界

除退出外，所有写入需要 `Idempotency-Key`（16—128 字符，推荐随机 UUID）；一次用户动作生成一个键，同次网络重传复用；新意图另生成。作用域为团队/操作者/方法/规范化路径（登录使用账号安全摘要/Origin），指纹包含规范化 JSON 和业务条件。键记录与业务变更一同提交。相同键不同指纹返回 `409 IDEMPOTENCY_KEY_REUSED`，不重做。初稿保留至少 24 小时，客户端过期后先查询，不凭新键盲目重试。无业务副作用的校验失败不消费键；接受后重放优先于旧 revision 检查，但必须先验证调用者仍有权限。

键是 HTTP 动作防重；发布的 `(taskId,contentVersionId,accountId)` 是永久业务唯一边界，即使换键也不能新建重复实际操作。明确失败后只能调用 `/publications/:operationId/retries`，仍复用操作 ID。只有持久化并占锁之后才外部发送。待人工发布也占发布锁；超时、崩溃、页面关闭、租约过期或观测故障不能证明未发布。

任务写入在同一任务原子边界比较 revision、内容指针、生命周期及锁。保存创建版本、换指针、失效批准、清空审核资格、递增 revision 和写审计同事务；失败不产生孤立版本。启动/重试原子取工作槽、冻结配置、失效批准、清空当前内容和审核引用；新尝试必须从研究开始。跨进程使用持久锁/唯一约束和 generation，禁止仅用内存标记。停止确认/旧执行器隔离完成前不释放工作槽；迟到旧代次结果不能提交。

**检查次序：** 会话/权限/对象归属 → 已接受的同键重放 → 发布业务唯一操作的只读复用（仅重新验证归属，禁止发送） → revision/基版 → 生命周期/锁/取消 → 审核/批准/账号及规则 → 原子提交。发布复用只返回原操作，不因旧 expectedRevision 新增发送；其他未决发布锁和错误账号仍拒绝。同键重试不同 dispatch、重复批准或已删除对象的状态型幂等均不得复活旧事实。

人工审核和完整执行共用工作槽；手动审核只冻结当前人工版本，不自动修改，不重置 autoRevisionCount。自动修改额度在调度前原子预留 1—3，失败不退还，技术重试复用轮次。保存或完整重试清除审核资格并使旧批准失效；审核通过只进入待批准。批准绑定版本、实际 UTF-8 文本摘要、账号、审核周期；发布再次校验。配置规则变化后不合格的原资格必须失效。

## 故障与冲突协议

错误结构固定，未适用字段必须为 null/空数组：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "内容已由其他成员更新，请比较后重新保存",
    "retryable": false,
    "fieldErrors": [],
    "conflict": {
      "expectedRevision": 12,
      "actualRevision": 13,
      "currentContentVersionId": "version-4",
      "latestVersionUrl": "/api/v1/tasks/task-demo/content-versions/version-4",
      "taskUrl": "/api/v1/tasks/task-demo"
    },
    "operationId": null,
    "dispatchId": null
  },
  "meta": { "requestId": "req-conflict" }
}
```

| HTTP / code                                                 | 含义与页面处理                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 400 VALIDATION_ERROR                                        | 类型/必填/长度/未知字段/游标不合法；展示 fieldErrors，不清空输入                                                           |
| 401 UNAUTHENTICATED                                         | 未登录、过期或禁用；本地保留草稿并导航登录，禁止自动重放旧写入                                                             |
| 403 FORBIDDEN                                               | 角色或 CSRF 不满足；禁止操作，提示原因，不自动提权                                                                         |
| 404 NOT_FOUND                                               | 不存在或跨团队；不泄露资源信息                                                                                             |
| 409 REVISION_CONFLICT                                       | 任务/对象版本或当前内容不一致；拒绝覆盖，保留输入，返回最新资源信息                                                        |
| 409 IDEMPOTENCY_KEY_REUSED                                  | 同键不同请求；保留输入，提示动作标识冲突，不自动换键重发                                                                   |
| 409 INVALID_STATE / APPROVAL_INVALID / ACCOUNT_UNAUTHORIZED | 状态、批准、账号不符；保持原状态，刷新资格和原因                                                                           |
| 422 REVIEW_BLOCKED / VALIDATION_ERROR                       | 确定性阻断、未处理事实问题、用途与记忆类型不相容等语义错误；不可人工强制绕过                                               |
| 423 WORK_LOCKED / PUBLICATION_LOCKED                        | 展示锁所属尝试/操作及处理入口；拒绝编辑、审核、批准、重执行或新发送                                                        |
| 409 RESULT_UNKNOWN                                          | 禁止再次发送，返回原 operationId/dispatchId；进入核实。已接受的同一发布请求优先返回 200/202 当前操作，而不是用超时伪装失败 |
| 429 RATE_LIMITED                                            | 返回 Retry-After 秒数，保留输入；写操作由人确认后按原键重试                                                                |
| 503 DEPENDENCY_UNAVAILABLE                                  | 仅确认外部调用未发起且无业务接受记录时；返回 retryable 和 Retry-After。发布不得仅凭该码认定未发                            |
| 500 INTERNAL_ERROR                                          | 未预期内部故障；附 requestId 排查，保留输入并查询业务事实，不自动重试写入或解除发布锁                                      |
| 501 NOT_IMPLEMENTED                                         | D1 占位；提示接口待接入，不显示已创建/已发布                                                                               |

对象版本冲突时 conflict.expectedRevision/actualRevision 对应请求的 expectedVersion/最新对象版本，taskUrl 指向该对象最新 GET 地址；currentContentVersionId/latestVersionUrl 在非任务场景为 null。任务保存冲突必须提供最新任务地址和当前版本地址；首次无内容时 latestVersionUrl 指向任务地址。界面保留编辑缓冲区与原基版；打开最新版本/比较不自动替换缓冲区。人工选择合并后重新 GET revision，明确点击保存作为新动作；仍冲突继续拒绝。

客户端读取超时初稿 15 秒，写入等待 30 秒后停止等待并提示“结果待查询”，不表示服务端取消。GET 可有限重试 2 次（退避、遵循 Retry-After）；所有写操作不使用自动重试中间件。已接受的异步工作 GET 每 3 秒查询，离开/隐藏页面暂停轮询，失败展示最后确认状态。发布响应丢失且无 operationId 时，按任务发布列表和当前版本查询稳定操作；查询失败继续锁定并提示未知，不能生成新发送。服务端任何发送不确定均写 P05，回填/核实最终一致收敛。

核实成功必须核对实际账号、版本、摘要、平台标识和证据；差异进入待核实，不能标记批准版本成功。认定 not_published 必须有可引用证据以及前次不会再生效的可靠结论，`previousDispatchFenced=true` 只是声明，服务端还须验证证据；仍不确定维持原锁。迟到成功证据关联原 dispatch，阻止新发送。成功事实不被矛盾回填撤销；矛盾证据另追加审计并升级人工处理。Cloud 上报失败只记观测故障与补报，不改业务发布事实。

记忆禁用/删除先更新业务版本并停止召回，再后台同步受管副本。候选 active 不等于用于正式创作。删除后正文不返回；清理失败显示目标范围、错误和重试入口，不宣称所有历史副本均已清除。删除、索引、旧版本同步都不得复活 tombstone。

## 成功字段的解释与页面刷新

| 响应对象                     | 主要字段含义                                                                                                                                   | 操作后刷新                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| TaskDetail                   | task 为权威任务；execution/approval/publication/reflection 为独立投影；workLock 为工作占用；actions 含 allowed/reason；null 当前对象表示不存在 | 任何任务命令后详情 + 列表；按操作补拉版本/审核/发布/审计 |
| ContentVersion / SaveContent | body 是原样正文；contentHash 为实际发送 UTF-8 SHA-256；versionNo 为展示序号；originAttemptId 只作来源；message 为保存提示                      | 当前内容、版本历史、审核区、批准区、列表                 |
| ReviewCycle                  | status 是运行状态，records[].outcome 才是结论；blockingIssues 区分确定性/事实/主观；scores.source 明确来源                                     | 周期 + 任务详情；通过后展示批准，不自动发布              |
| Approval                     | 固定版本/账号/摘要/审核周期；invalidatedReason 可解释旧批准失效                                                                                | 详情、批准历史审计、操作资格                             |
| PublishOperation             | id 为稳定操作；dispatches 每次发送；verifications 追加证据；status=verification_required 保持发布锁                                            | 发布操作、任务详情、列表；成功只提供复制入口             |
| Memory / MemorySyncJob       | type/status/syncStatus 独立；version 为业务版本；targetVersion 为同步目标；deleted 正文 null；lastError/targetScopes 解释未完成范围            | 详情、列表、同步记录；不等待索引同步才停止召回           |
| Reflection                   | observations 与 hypotheses 分列；evidenceRefs 为可查证据；uncertainties 保留局限；candidateMemoryIds 是候选，不是正式策略                      | 复盘历史与详情；保存候选后刷新记忆列表                   |
| Config / Member / Account    | version 用于并发；账号只返回授权状态与官方发布可用性；配置只保存安全引用，不包含明文凭据                                                       | 设置数据、当前成员权限、受影响任务资格                   |
| Experiment / BlindItem       | offline 必须 true；摘要包含失败和限制；盲评内容中无分组/模型/轨迹；item=null 表示完成                                                          | 实验摘要、盲评剩余数量；绝不刷新实际发布成功             |

## 关键请求示例与验收走查

保存 V3：

```http
POST /api/v1/tasks/task-demo/content-versions
Content-Type: application/json
Idempotency-Key: 8f2abcde-1234-4000-9000-123456789abc
X-CSRF-Token: <session-token>

{"expectedRevision":12,"baseContentVersionId":"version-3","body":"编辑后的原样正文"}
```

成功新版本、revision、批准失效和审计必须一起提交，返回 201 SaveContent；前端显示“新版本已保存，需要提交审核”。另一成员以旧 revision 或基版保存应 409，无覆盖、无新版本、输入保留。批准成功后返回 ApprovalResult（包含 Approval 记录和 TaskDetail），发布必须另 POST，绝不在批准处理中调用外部平台。响应包装与领域记录使用不同的 Schema 名称，线上 JSON 仍为 `{ data: { approval, task }, meta }`。

| AC  | 契约与设计覆盖                               | 后续业务验收证据（D1 未执行）      |
| --- | -------------------------------------------- | ---------------------------------- |
| 01  | 创建→执行→审核→批准→发布/人工回填            | 真实发布记录及渠道                 |
| 02  | clarification / E02—E03                      | 信息不足不生成，答复关联尝试       |
| 03  | attempt、review、额度字段                    | 三轮累计与有限技术重试             |
| 04  | save/review/decision/terminate               | 确定性阻断服务端拒绝               |
| 05  | save 双版本比较、approval、publish           | S1；并发保存和发布仅一方可接受     |
| 06  | operation 唯一、dispatch、verification/retry | S2；重复/超时/重启无多发           |
| 07  | stop 与 terminate 分开                       | 隔离前不解锁，外部请求不伪撤回     |
| 08  | me、roles、设置、账号授权                    | 服务端 403/404、无授权发布零调用   |
| 09  | purpose/type/status、删除同步                | S3；清理失败仍不召回，旧任务不复活 |
| 10  | history、sourceRefs、scores.source、traceUrl | 无密钥/内部推理，来源可追溯        |
| 11  | 发布未知与观测故障分离                       | Cloud 故障不重发、不回滚           |
| 12  | reflection 与 candidate/confirmation         | 证据/假设/不确定性，零自动配置变化 |
| 13  | offline 实验与匿名盲评                       | 固定条件、匿名评分、零实际发布     |
| 14  | officialPublishAvailable 与授权校验          | 权限开通后受控真实 API 专项核对    |

待确认：生产登录部署、平台格式与官方查询能力、模型/工具超时及重试上限、外部 Cloud 留存及清理范围。本文给出的 HTTP 客户端超时/会话时长为可走查默认值，不作为供应商能力承诺。D1 仅完成设计、类型、结构校验与页面骨架，不能据此将上述业务 AC 标记通过。
