# 接口逐项参考（生成文件）

由 shared 契约生成；运行 `npm run contract:generate` 更新。通用权限、错误、超时与审计规则见 [接口契约说明](api-contract.md)。D3 已实现登录、当前身份、退出及业务接口会话/角色/写入 Origin/CSRF 校验；通过权限检查后，其他业务处理仍为 501 占位。

| 操作 ID               | 方法与路径                                                         | 用途                                                |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| login                 | POST /api/v1/auth/login                                            | [成员登录](#login)                                  |
| logout                | POST /api/v1/auth/logout                                           | [退出并撤销当前会话](#logout)                       |
| getMe                 | GET /api/v1/auth/me                                                | [当前成员与权限](#getme)                            |
| listMembers           | GET /api/v1/members                                                | [查询团队成员](#listmembers)                        |
| updateMember          | PATCH /api/v1/members/:memberId                                    | [修改成员角色或状态](#updatemember)                 |
| getAccount            | GET /api/v1/accounts/:accountId                                    | [账号及授权摘要](#getaccount)                       |
| authorizeAccount      | POST /api/v1/accounts/:accountId/authorization-sessions            | [创建官方账号授权会话](#authorizeaccount)           |
| createTask            | POST /api/v1/tasks                                                 | [创建草稿任务，不自动执行](#createtask)             |
| listTasks             | GET /api/v1/tasks                                                  | [分页查询任务及四维状态](#listtasks)                |
| getTask               | GET /api/v1/tasks/:taskId                                          | [任务详情、锁与操作资格](#gettask)                  |
| taskHistory           | GET /api/v1/tasks/:taskId/history                                  | [执行步骤、尝试与审计](#taskhistory)                |
| clarifyTask           | POST /api/v1/tasks/:taskId/clarifications                          | [答复当前尝试的澄清问题](#clarifytask)              |
| startTask             | POST /api/v1/tasks/:taskId/attempts                                | [首次启动完整执行](#starttask)                      |
| stopAttempt           | POST /api/v1/tasks/:taskId/attempts/:attemptId/stop                | [停止本次执行以便编辑](#stopattempt)                |
| retryTask             | POST /api/v1/tasks/:taskId/attempt-retries                         | [重新执行或显式重启已终止任务](#retrytask)          |
| terminateTask         | POST /api/v1/tasks/:taskId/terminate                               | [终止任务并阻止后续发布](#terminatetask)            |
| copyTask              | POST /api/v1/tasks/:taskId/copies                                  | [复制为新任务](#copytask)                           |
| listContent           | GET /api/v1/tasks/:taskId/content-versions                         | [内容版本历史](#listcontent)                        |
| getContent            | GET /api/v1/tasks/:taskId/content-versions/:versionId              | [读取某个不可变版本](#getcontent)                   |
| compareContent        | GET /api/v1/tasks/:taskId/content-comparison                       | [比较两个已保存版本](#comparecontent)               |
| saveContent           | POST /api/v1/tasks/:taskId/content-versions                        | [保存新内容版本，不自动审核](#savecontent)          |
| submitReview          | POST /api/v1/tasks/:taskId/reviews                                 | [手动提交当前版本审核](#submitreview)               |
| listReviews           | GET /api/v1/tasks/:taskId/reviews                                  | [审核周期历史](#listreviews)                        |
| getReview             | GET /api/v1/tasks/:taskId/reviews/:reviewId                        | [审核结果、阻断与评分来源](#getreview)              |
| stopReview            | POST /api/v1/tasks/:taskId/reviews/:reviewId/stop                  | [取消人工审核](#stopreview)                         |
| decideReview          | POST /api/v1/tasks/:taskId/reviews/:reviewId/decisions             | [人工裁决主观分歧](#decidereview)                   |
| approveContent        | POST /api/v1/tasks/:taskId/approvals                               | [批准指定版本，等待用户点击发布](#approvecontent)   |
| publishContent        | POST /api/v1/tasks/:taskId/publications                            | [点击发布或创建人工交接](#publishcontent)           |
| listPublications      | GET /api/v1/tasks/:taskId/publications                             | [发布操作历史](#listpublications)                   |
| getPublication        | GET /api/v1/tasks/:taskId/publications/:operationId                | [读取稳定发布操作、发送及核实证据](#getpublication) |
| backfillPublication   | POST /api/v1/tasks/:taskId/publications/:operationId/backfills     | [人工交接回填或明确未发送](#backfillpublication)    |
| verifyPublication     | POST /api/v1/tasks/:taskId/publications/:operationId/verifications | [追加人工核实，不发送文案](#verifypublication)      |
| retryPublication      | POST /api/v1/tasks/:taskId/publications/:operationId/retries       | [明确失败后的人工重试](#retrypublication)           |
| listMemories          | GET /api/v1/memories                                               | [按类型、用途、状态查询记忆](#listmemories)         |
| getMemory             | GET /api/v1/memories/:memoryId                                     | [记忆详情与来源](#getmemory)                        |
| editMemory            | PATCH /api/v1/memories/:memoryId                                   | [编辑记忆，创建新业务版本](#editmemory)             |
| setMemoryAvailability | POST /api/v1/memories/:memoryId/availability                       | [明确禁用或启用记忆](#setmemoryavailability)        |
| deleteMemory          | DELETE /api/v1/memories/:memoryId                                  | [删除记忆并立即停止召回](#deletememory)             |
| confirmMemory         | POST /api/v1/memories/:memoryId/confirmations                      | [人工确认候选，创建独立已确认经验](#confirmmemory)  |
| listMemorySync        | GET /api/v1/memories/:memoryId/sync-jobs                           | [受管同步/清理状态与失败范围](#listmemorysync)      |
| retryMemorySync       | POST /api/v1/memories/:memoryId/sync-jobs/:jobId/retry             | [重试失败的同步/清理](#retrymemorysync)             |
| createReflection      | POST /api/v1/tasks/:taskId/reflections                             | [手动触发复盘](#createreflection)                   |
| listReflections       | GET /api/v1/tasks/:taskId/reflections                              | [复盘历史](#listreflections)                        |
| getReflection         | GET /api/v1/tasks/:taskId/reflections/:reflectionId                | [证据、观察、假设与不确定性](#getreflection)        |
| retryReflection       | POST /api/v1/tasks/:taskId/reflections/:reflectionId/retries       | [再次复盘，新建关联记录](#retryreflection)          |
| saveCandidate         | POST /api/v1/tasks/:taskId/reflections/:reflectionId/candidates    | [把复盘建议保存为候选经验](#savecandidate)          |
| getConfig             | GET /api/v1/config                                                 | [读取无密钥配置及版本](#getconfig)                  |
| updateConfig          | PUT /api/v1/config                                                 | [保存完整配置新版本](#updateconfig)                 |
| listExperiments       | GET /api/v1/experiments                                            | [离线实验摘要](#listexperiments)                    |
| runExperiment         | POST /api/v1/experiments                                           | [运行已配置离线实验](#runexperiment)                |
| getExperiment         | GET /api/v1/experiments/:experimentId                              | [实验摘要及 Langfuse 链接](#getexperiment)          |
| nextBlindItem         | GET /api/v1/experiments/:experimentId/blind-items/next             | [读取当前成员未评分的匿名样本](#nextblinditem)      |
| submitBlindScore      | POST /api/v1/experiments/:experimentId/blind-scores                | [提交人工盲评](#submitblindscore)                   |

## login

`POST /api/v1/auth/login` — 成员登录。

权限：无需已登录会话。

前置条件与业务校验：内部成员口令登录；成员 active；统一凭据错误，账号/IP 持久限流；可信 Origin；成功设置 HttpOnly 会话 Cookie，绝对有效 8 小时。

请求头：Idempotency-Key 必填，16—128 字符；登录校验 Origin。

JSON 请求体（未列字段拒绝）：

| 字段     | 必填 | 类型   | 校验             |
| -------- | ---- | ------ | ---------------- |
| login    | 是   | string | 最短 1；最长 254 |
| password | 是   | string | 最短 8；最长 256 |

成功：HTTP 200，`{ data: Session, meta: { requestId, replayed } }`。data 字段：

| 字段        | 类型                                                                                                          | 含义                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| member      | Member                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| permissions | "tasks:write" / "approval:write" / "publish:write" / "memory:write" / "evaluation:write" / "settings:write"[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| csrfToken   | string                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| expiresAt   | string                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；凭据仍有效时同键同请求复用原会话，权限反映当前成员角色；同键不同请求 409；已退出、过期或撤销的会话不复活。重放材料仅加密持久化。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：auth.login（不含口令）。验收：AC-08（关联设计，不表示已验收）。

## logout

`POST /api/v1/auth/logout` — 退出并撤销当前会话。

权限：admin / operator。

前置条件与业务校验：允许会话已过期；校验同源，已有会话须 CSRF。

请求头：Idempotency-Key 可选；X-CSRF-Token 必填（已过期退出会话例外）。

无请求体。

成功：HTTP 200，`{ data: Logout, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型 | 含义                                                |
| --------- | ---- | --------------------------------------------------- |
| signedOut | true | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：重复退出返回 signedOut=true；清除 Cookie。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：auth.logout。验收：AC-08（关联设计，不表示已验收）。

## getMe

`GET /api/v1/auth/me` — 当前成员与权限。

权限：admin / operator。

前置条件与业务校验：有效会话；禁用成员的会话立即失效。

成功：HTTP 200，`{ data: Session, meta: { requestId, replayed } }`。data 字段：

| 字段        | 类型                                                                                                          | 含义                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| member      | Member                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| permissions | "tasks:write" / "approval:write" / "publish:write" / "memory:write" / "evaluation:write" / "settings:write"[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| csrfToken   | string                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| expiresAt   | string                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：安全访问日志。验收：AC-08（关联设计，不表示已验收）。

## listMembers

`GET /api/v1/members` — 查询团队成员。

权限：admin。

前置条件与业务校验：仅管理员；不返回凭据。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: Members, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | Member[]      | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：安全访问日志。验收：AC-08（关联设计，不表示已验收）。

## updateMember

`PATCH /api/v1/members/:memberId` — 修改成员角色或状态。

权限：admin。

前置条件与业务校验：比较成员版本；不能禁用或降级最后一名 active 管理员；禁用立即撤销会话。

路径字段：`memberId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型                  | 校验                          |
| --------------- | ---- | --------------------- | ----------------------------- |
| expectedVersion | 是   | integer               | 最小 1；最大 9007199254740991 |
| role            | 是   | "admin" / "operator"  | 见业务前置条件                |
| status          | 是   | "active" / "disabled" | 见业务前置条件                |

成功：HTTP 200，`{ data: Member, meta: { requestId, replayed } }`。data 字段：

| 字段        | 类型                  | 含义                                                |
| ----------- | --------------------- | --------------------------------------------------- |
| id          | string                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| teamId      | string                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| displayName | string                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| role        | "admin" / "operator"  | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status      | "active" / "disabled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| version     | number                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：member.updated。验收：AC-08（关联设计，不表示已验收）。

## getAccount

`GET /api/v1/accounts/:accountId` — 账号及授权摘要。

权限：admin / operator。

前置条件与业务校验：同团队固定账号；不返回令牌。

路径字段：`accountId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Account, meta: { requestId, replayed } }`。data 字段：

| 字段                     | 类型                                 | 含义                                                |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| id                       | string                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| displayName              | string                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| platform                 | "weibo"                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| authorizationStatus      | "unconfigured" / "valid" / "expired" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| officialPublishAvailable | boolean                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：安全访问日志。验收：AC-08、AC-14（关联设计，不表示已验收）。

## authorizeAccount

`POST /api/v1/accounts/:accountId/authorization-sessions` — 创建官方账号授权会话。

权限：admin。

前置条件与业务校验：仅管理员；官方授权 URL 白名单、短期 state、防 CSRF；不接收或返回明文密钥。授权回调实现留到集成阶段。

路径字段：`accountId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

无请求体。

成功：HTTP 202，`{ data: AuthorizationSession, meta: { requestId, replayed } }`。data 字段：

| 字段             | 类型   | 含义                                                |
| ---------------- | ------ | --------------------------------------------------- |
| authorizationUrl | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| state            | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| expiresAt        | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：account.authorization_requested。验收：AC-08、AC-14（关联设计，不表示已验收）。

## createTask

`POST /api/v1/tasks` — 创建草稿任务，不自动执行。

权限：admin / operator。

前置条件与业务校验：服务端固定团队唯一账号；revision=1、lifecycle=open；所有当前引用为空。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                    | 必填 | 类型     | 校验                        |
| ----------------------- | ---- | -------- | --------------------------- |
| title                   | 是   | string   | 最短 1；最长 120            |
| originalRequest         | 是   | string   | 最短 1；最长 10000          |
| referenceInputs         | 否   | object[] | 最少项 0；最多项 100        |
| referenceInputs[].label | 是   | string   | 最短 1；最长 200            |
| referenceInputs[].url   | 是   | string   | 最短 1；最长 2048；格式 uri |

成功：HTTP 201，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：A01。审计：task.created。验收：AC-01（关联设计，不表示已验收）。

## listTasks

`GET /api/v1/tasks` — 分页查询任务及四维状态。

权限：admin / operator。

前置条件与业务校验：同团队；筛选 AND 组合；updatedAt DESC,id DESC 稳定游标。

查询参数（未列字段拒绝）：

| 字段        | 必填 | 类型                                                                                                   | 校验             |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| cursor      | 否   | string                                                                                                 | 最短 1；最长 512 |
| limit       | 否   | integer                                                                                                | 最小 1；最大 100 |
| q           | 否   | string                                                                                                 | 最短 1；最长 120 |
| lifecycle   | 否   | "open" / "terminated" / "published"                                                                    | 见业务前置条件   |
| execution   | 否   | "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 见业务前置条件   |
| approval    | 否   | "not_requested" / "pending" / "approved" / "invalidated"                                               | 见业务前置条件   |
| publication | 否   | "not_published" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "failed"  | 见业务前置条件   |

成功：HTTP 200，`{ data: Tasks, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | TaskSummary[] | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-01、AC-10（关联设计，不表示已验收）。

## getTask

`GET /api/v1/tasks/:taskId` — 任务详情、锁与操作资格。

权限：admin / operator。

前置条件与业务校验：同团队；一次一致性快照；actions 是服务端建议，每次写入仍须重校验。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-01、AC-10（关联设计，不表示已验收）。

## taskHistory

`GET /api/v1/tasks/:taskId/history` — 执行步骤、尝试与审计。

权限：admin / operator。

前置条件与业务校验：同团队；cursor 仅作用于 audit；attempts/steps 为首期有界完整记录；不含内部推理或凭据。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: History, meta: { requestId, replayed } }`。data 字段：

| 字段     | 类型               | 含义                                                |
| -------- | ------------------ | --------------------------------------------------- |
| attempts | ExecutionAttempt[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| steps    | AgentStep[]        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| audit    | Page_AuditEvent_   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-03、AC-10、AC-11（关联设计，不表示已验收）。

## clarifyTask

`POST /api/v1/tasks/:taskId/clarifications` — 答复当前尝试的澄清问题。

权限：admin / operator。

前置条件与业务校验：open；当前 attempt=awaiting_clarification，无取消或发布锁；问题属于当前尝试；追加答复，不覆盖历史。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                 | 必填 | 类型     | 校验                                    |
| -------------------- | ---- | -------- | --------------------------------------- |
| expectedRevision     | 是   | integer  | 最小 1；最大 9007199254740991           |
| attemptId            | 是   | string   | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| answers              | 是   | object[] | 最少项 1；最多项 100                    |
| answers[].questionId | 是   | string   | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| answers[].answer     | 是   | string   | 最短 1；最长 4000                       |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：E02、E03。审计：task.clarified。验收：AC-02（关联设计，不表示已验收）。

## startTask

`POST /api/v1/tasks/:taskId/attempts` — 首次启动完整执行。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。尚无完整尝试；新尝试从研究开始，计数=0，配置快照冻结；清空当前内容/审核、失效旧批准。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                          |
| ---------------- | ---- | ------- | ----------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991 |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：E01、A05。审计：attempt.started。验收：AC-01、AC-03、AC-05（关联设计，不表示已验收）。

## stopAttempt

`POST /api/v1/tasks/:taskId/attempts/:attemptId/stop` — 停止本次执行以便编辑。

权限：admin / operator。

前置条件与业务校验：当前尝试待澄清/queued/running、无发布锁；只记录取消意图；必须确认停止/隔离旧 generation 后解锁；任务仍 open。

路径字段：`taskId`、`attemptId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                          |
| ---------------- | ---- | ------- | ----------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991 |
| reason           | 是   | string  | 最短 1；最长 2000             |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：E10、E11、E12。审计：attempt.stop_requested / attempt.stopped。验收：AC-07（关联设计，不表示已验收）。

## retryTask

`POST /api/v1/tasks/:taskId/attempt-retries` — 重新执行或显式重启已终止任务。

权限：admin / operator。

前置条件与业务校验：任务未发布、无工作/发布锁；previousAttemptId 匹配当前已结束尝试；从未执行就已终止时显式传 null；terminated 须 restartTerminated=true；新 attemptNo，从研究开始，不续跑旧步骤。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段              | 必填 | 类型          | 校验                                    |
| ----------------- | ---- | ------------- | --------------------------------------- |
| expectedRevision  | 是   | integer       | 最小 1；最大 9007199254740991           |
| previousAttemptId | 是   | string / null | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| restartTerminated | 是   | boolean       | 见业务前置条件                          |
| reason            | 是   | string        | 最短 1；最长 2000                       |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：E13、A05。审计：attempt.retried / task.reopened。验收：AC-03、AC-05、AC-07（关联设计，不表示已验收）。

## terminateTask

`POST /api/v1/tasks/:taskId/terminate` — 终止任务并阻止后续发布。

权限：admin / operator。

前置条件与业务校验：未发布且无发布锁；允许运行工作存在，原子置 terminated、失效批准并取消所有工作；停止未确认仍保留工作槽。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                          |
| ---------------- | ---- | ------- | ----------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991 |
| reason           | 是   | string  | 最短 1；最长 2000             |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：E10、E11、E12、C08、A06。审计：task.terminated。验收：AC-07（关联设计，不表示已验收）。

## copyTask

`POST /api/v1/tasks/:taskId/copies` — 复制为新任务。

权限：admin / operator。

前置条件与业务校验：任意可读任务；快照 revision；指定来源版必须属于原任务；新任务 sourceTaskId，复制文案为新 manual V1，审核/批准/发布引用均空；不自动执行。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                   | 必填 | 类型          | 校验                                    |
| ---------------------- | ---- | ------------- | --------------------------------------- |
| expectedRevision       | 是   | integer       | 最小 1；最大 9007199254740991           |
| sourceContentVersionId | 是   | string / null | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| title                  | 是   | string        | 最短 1；最长 120                        |

成功：HTTP 201，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：P15、A01。审计：task.copied。验收：AC-01、AC-06（关联设计，不表示已验收）。

## listContent

`GET /api/v1/tasks/:taskId/content-versions` — 内容版本历史。

权限：admin / operator。

前置条件与业务校验：同任务；versionNo DESC；不可变内容。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: ContentVersions, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型             | 含义                            |
| ---------- | ---------------- | ------------------------------- |
| items      | ContentVersion[] | 当前分页结果                    |
| nextCursor | null / string    | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-05、AC-10（关联设计，不表示已验收）。

## getContent

`GET /api/v1/tasks/:taskId/content-versions/:versionId` — 读取某个不可变版本。

权限：admin / operator。

前置条件与业务校验：版本属于路径任务及团队。

路径字段：`taskId`、`versionId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: ContentVersion, meta: { requestId, replayed } }`。data 字段：

| 字段            | 类型               | 含义                                                |
| --------------- | ------------------ | --------------------------------------------------- |
| id              | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId          | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| originAttemptId | null / string      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| parentVersionId | null / string      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| versionNo       | number             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| body            | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| contentHash     | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceKind      | "agent" / "manual" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| revisionRoundId | null / string      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceRefs      | SourceRef[]        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| usedMemoryRefs  | MemoryRef[]        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdBy       | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt       | string             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-05、AC-10（关联设计，不表示已验收）。

## compareContent

`GET /api/v1/tasks/:taskId/content-comparison` — 比较两个已保存版本。

权限：admin / operator。

前置条件与业务校验：两版本同任务；未保存的用户输入只在客户端本地比较。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段          | 必填 | 类型   | 校验                                    |
| ------------- | ---- | ------ | --------------------------------------- |
| fromVersionId | 是   | string | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| toVersionId   | 是   | string | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |

成功：HTTP 200，`{ data: CompareVersions, meta: { requestId, replayed } }`。data 字段：

| 字段    | 类型           | 含义                                                |
| ------- | -------------- | --------------------------------------------------- |
| from    | ContentVersion | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| to      | ContentVersion | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| changes | object[]       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：C03。审计：访问日志。验收：AC-05（关联设计，不表示已验收）。

## saveContent

`POST /api/v1/tasks/:taskId/content-versions` — 保存新内容版本，不自动审核。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。同时比较当前版本 ID（首次为 null）；正文非全空，不 trim 或归一化实际发送正文；格式问题允许保存，但阻断审核/批准/发布。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                 | 必填 | 类型          | 校验                                    |
| -------------------- | ---- | ------------- | --------------------------------------- |
| expectedRevision     | 是   | integer       | 最小 1；最大 9007199254740991           |
| baseContentVersionId | 是   | string / null | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| body                 | 是   | string        | 最短 1；最长 20000                      |

成功：HTTP 201，`{ data: SaveContent, meta: { requestId, replayed } }`。data 字段：

| 字段    | 类型                         | 含义                                                |
| ------- | ---------------------------- | --------------------------------------------------- |
| task    | TaskDetail                   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| content | ContentVersion               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| message | "新版本已保存，需要提交审核" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：C02、C03、A05。审计：content.saved / approval.invalidated。验收：AC-04、AC-05（关联设计，不表示已验收）。

## submitReview

`POST /api/v1/tasks/:taskId/reviews` — 手动提交当前版本审核。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。当前人工版；原子取得 manual_review 工作槽，冻结版本；只审核不重写，不重置三轮计数；当前已完成通过周期返回已有结果。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                                    |
| ---------------- | ---- | ------- | --------------------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |

成功：HTTP 202，`{ data: Review, meta: { requestId, replayed } }`。data 字段：

| 字段             | 类型                                                        | 含义                                                |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| id               | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId           | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptId        | null / string                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| trigger          | "initial_generation" / "manual_submit"                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| inputVersionId   | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentVersionId | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status           | "queued" / "running" / "failed" / "cancelled" / "completed" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| records          | ReviewRecord[]                                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| requestedBy      | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| configVersion    | number                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt        | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt       | null / string                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| error            | null / object                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：C04、C10。审计：review.submitted。验收：AC-03、AC-04、AC-05（关联设计，不表示已验收）。

## listReviews

`GET /api/v1/tasks/:taskId/reviews` — 审核周期历史。

权限：admin / operator。

前置条件与业务校验：同任务；completed 与 pass 独立。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: Reviews, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | ReviewCycle[] | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-04、AC-10（关联设计，不表示已验收）。

## getReview

`GET /api/v1/tasks/:taskId/reviews/:reviewId` — 审核结果、阻断与评分来源。

权限：admin / operator。

前置条件与业务校验：同任务；记录冻结目标版本；事实不足不按模型高分放行。

路径字段：`taskId`、`reviewId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Review, meta: { requestId, replayed } }`。data 字段：

| 字段             | 类型                                                        | 含义                                                |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| id               | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId           | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptId        | null / string                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| trigger          | "initial_generation" / "manual_submit"                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| inputVersionId   | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentVersionId | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status           | "queued" / "running" / "failed" / "cancelled" / "completed" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| records          | ReviewRecord[]                                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| requestedBy      | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| configVersion    | number                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt        | string                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt       | null / string                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| error            | null / object                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-03、AC-04、AC-10（关联设计，不表示已验收）。

## stopReview

`POST /api/v1/tasks/:taskId/reviews/:reviewId/stop` — 取消人工审核。

权限：admin / operator。

前置条件与业务校验：当前 manual_submit 周期 queued/running；无发布锁；停止/隔离确认前保持槽；不取消历史已完成周期。

路径字段：`taskId`、`reviewId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                          |
| ---------------- | ---- | ------- | ----------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991 |
| reason           | 是   | string  | 最短 1；最长 2000             |

成功：HTTP 202，`{ data: TaskDetail, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                                                          | 含义                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| currentAttempt     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentContent     | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentReview      | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentApproval    | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentPublication | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| latestReflection   | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| workLock           | null / object                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| actions            | object                                                                                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| account            | Account                                                                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task               | Task                                                                                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| execution          | null / "awaiting_clarification" / "queued" / "running" / "manual_required" / "ready" / "failed" / "cancelled" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| approval           | "approved" / "invalidated" / "not_requested" / "pending"                                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| publication        | "failed" / "awaiting_manual" / "publishing" / "verification_required" / "published" / "not_published"         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| reflection         | "failed" / "completed" / "processing" / "not_triggered"                                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| currentStep        | null / string                                                                                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：C08。审计：review.stop_requested / review.cancelled。验收：AC-07（关联设计，不表示已验收）。

## decideReview

`POST /api/v1/tasks/:taskId/reviews/:reviewId/decisions` — 人工裁决主观分歧。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。当前已完成审核；仅裁决 subjective；accepted/unresolved 必须互斥且覆盖待裁决项；确定性阻断仍拒绝，事实不足先补证/修改重审；追加决定，不改旧 ReviewRecord。

路径字段：`taskId`、`reviewId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型     | 校验                                    |
| ---------------- | ---- | -------- | --------------------------------------- |
| expectedRevision | 是   | integer  | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string   | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| reviewRecordId   | 是   | string   | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| reason           | 是   | string   | 最短 1；最长 2000                       |
| acceptedIssues   | 是   | string[] | 最少项 0；最多项 100                    |
| unresolvedIssues | 是   | string[] | 最少项 0；最多项 100                    |
| evidenceIds      | 是   | string[] | 最少项 0；最多项 100                    |

成功：HTTP 201，`{ data: Decision, meta: { requestId, replayed } }`。data 字段：

| 字段     | 类型           | 含义                                                |
| -------- | -------------- | --------------------------------------------------- |
| decision | ManualDecision | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task     | TaskDetail     | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：A02、A07。审计：review.decided。验收：AC-04（关联设计，不表示已验收）。

## approveContent

`POST /api/v1/tasks/:taskId/approvals` — 批准指定版本，等待用户点击发布。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。审核 pass 或合法主观裁决；无未解决阻断；允许批准自己的文案；同版本有效批准已存在则 200 返回已有批准。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型    | 校验                                    |
| ---------------- | ---- | ------- | --------------------------------------- |
| expectedRevision | 是   | integer | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| reviewCycleId    | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| accountId        | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| contentHash      | 是   | string  | 匹配 ^[a-f0-9]{64}$                     |

成功：HTTP 201（已有有效批准时 200），`{ data: ApprovalResult, meta: { requestId, replayed } }`。data 字段：

| 字段     | 类型       | 含义                                                |
| -------- | ---------- | --------------------------------------------------- |
| approval | Approval   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task     | TaskDetail | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：A03、A04、A07。审计：approval.created / approval.replayed。验收：AC-04、AC-05、AC-08（关联设计，不表示已验收）。

## publishContent

`POST /api/v1/tasks/:taskId/publications` — 点击发布或创建人工交接。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。当前版本、摘要、账号、审核、批准均匹配，账号授权有效，无历史成功发布。官方渠道须 officialPublishAvailable；manual 冻结批准文案并占锁；唯一键(taskId,contentVersionId,accountId)。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型                      | 校验                                    |
| ---------------- | ---- | ------------------------- | --------------------------------------- |
| expectedRevision | 是   | integer                   | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| accountId        | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| approvalId       | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| contentHash      | 是   | string                    | 匹配 ^[a-f0-9]{64}$                     |
| channel          | 是   | "official_api" / "manual" | 见业务前置条件                          |

成功：HTTP 202，`{ data: Publication, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型             | 含义                                                |
| --------- | ---------------- | --------------------------------------------------- |
| operation | PublishOperation | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task      | TaskDetail       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：无论 HTTP 键是否相同，同版本同账号复用稳定 operationId；待人工/发布中/待核实或已成功只返回原操作，不增 dispatch；failed 返回原失败，仅专用 retries 可新增发送。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：P01、P02、P13。审计：publication.requested / publication.handed_off。验收：AC-01、AC-06、AC-08、AC-14（关联设计，不表示已验收）。

## listPublications

`GET /api/v1/tasks/:taskId/publications` — 发布操作历史。

权限：admin / operator。

前置条件与业务校验：同任务；包含旧版本操作，不改绑新版本。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: Publications, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型               | 含义                            |
| ---------- | ------------------ | ------------------------------- |
| items      | PublishOperation[] | 当前分页结果                    |
| nextCursor | null / string      | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-06、AC-10、AC-11（关联设计，不表示已验收）。

## getPublication

`GET /api/v1/tasks/:taskId/publications/:operationId` — 读取稳定发布操作、发送及核实证据。

权限：admin / operator。

前置条件与业务校验：同任务；HTTP 超时后优先读取本操作或列表；读失败不释放锁。

路径字段：`taskId`、`operationId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Publication, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型             | 含义                                                |
| --------- | ---------------- | --------------------------------------------------- |
| operation | PublishOperation | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task      | TaskDetail       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-06、AC-11（关联设计，不表示已验收）。

## backfillPublication

`POST /api/v1/tasks/:taskId/publications/:operationId/backfills` — 人工交接回填或明确未发送。

权限：admin / operator。

前置条件与业务校验：awaiting_manual；dispatchId 为当前人工交接；版本/账号匹配；published 必须平台 ID/链接/实际摘要匹配；不匹配或不确定进入待核实；not_published 须可靠未发送声明并 previousDispatchFenced=true。

路径字段：`taskId`、`operationId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                   | 必填 | 类型                                      | 校验                                    |
| ---------------------- | ---- | ----------------------------------------- | --------------------------------------- |
| expectedRevision       | 是   | integer                                   | 最小 1；最大 9007199254740991           |
| contentVersionId       | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| dispatchId             | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| accountId              | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| conclusion             | 是   | "published" / "not_published" / "unknown" | 见业务前置条件                          |
| platformPostId         | 否   | string                                    | 最短 1；最长 128                        |
| url                    | 否   | string                                    | 最短 1；最长 2048；格式 uri             |
| observedContentHash    | 否   | string                                    | 匹配 ^[a-f0-9]{64}$                     |
| evidenceIds            | 是   | string[]                                  | 最少项 1；最多项 100                    |
| note                   | 是   | string                                    | 最短 1；最长 2000                       |
| previousDispatchFenced | 否   | boolean                                   | 见业务前置条件                          |

成功：HTTP 202，`{ data: Publication, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型             | 含义                                                |
| --------- | ---------------- | --------------------------------------------------- |
| operation | PublishOperation | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task      | TaskDetail       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：P06、P07、P08、P14。审计：publication.backfilled。验收：AC-01、AC-06、AC-07（关联设计，不表示已验收）。

## verifyPublication

`POST /api/v1/tasks/:taskId/publications/:operationId/verifications` — 追加人工核实，不发送文案。

权限：admin / operator。

前置条件与业务校验：verification_required；证据必须归属本发送；成功须账号/版本/摘要匹配；not_published 必须有前次不会再生效的证据及 previousDispatchFenced=true；unknown/差异继续锁定；method 由此端点记为 manual，不接受客户端声称 official_query。

路径字段：`taskId`、`operationId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                   | 必填 | 类型                                      | 校验                                    |
| ---------------------- | ---- | ----------------------------------------- | --------------------------------------- |
| expectedRevision       | 是   | integer                                   | 最小 1；最大 9007199254740991           |
| contentVersionId       | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| dispatchId             | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| accountId              | 是   | string                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| conclusion             | 是   | "published" / "not_published" / "unknown" | 见业务前置条件                          |
| platformPostId         | 否   | string                                    | 最短 1；最长 128                        |
| url                    | 否   | string                                    | 最短 1；最长 2048；格式 uri             |
| observedContentHash    | 否   | string                                    | 匹配 ^[a-f0-9]{64}$                     |
| evidenceIds            | 是   | string[]                                  | 最少项 1；最多项 100                    |
| note                   | 是   | string                                    | 最短 1；最长 2000                       |
| previousDispatchFenced | 否   | boolean                                   | 见业务前置条件                          |

成功：HTTP 202，`{ data: Publication, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型             | 含义                                                |
| --------- | ---------------- | --------------------------------------------------- |
| operation | PublishOperation | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task      | TaskDetail       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：P09、P10、P11、P14。审计：publication.verified。验收：AC-06、AC-07、AC-11、AC-14（关联设计，不表示已验收）。

## retryPublication

`POST /api/v1/tasks/:taskId/publications/:operationId/retries` — 明确失败后的人工重试。

权限：admin / operator。

前置条件与业务校验：同团队；任务 open、无工作槽、无取消意图、无发布锁；原子比较 expectedRevision。当前版本、摘要、账号、审核、批准均匹配，账号授权有效，无历史成功发布。操作为 failed，前次有可靠未发布证据且不会迟到生效；previousDispatchId 匹配；同 operationId 增 dispatchNo；绝不自动重发。

路径字段：`taskId`、`operationId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段               | 必填 | 类型                      | 校验                                    |
| ------------------ | ---- | ------------------------- | --------------------------------------- |
| expectedRevision   | 是   | integer                   | 最小 1；最大 9007199254740991           |
| contentVersionId   | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| accountId          | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| approvalId         | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| contentHash        | 是   | string                    | 匹配 ^[a-f0-9]{64}$                     |
| channel            | 是   | "official_api" / "manual" | 见业务前置条件                          |
| previousDispatchId | 是   | string                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| reason             | 是   | string                    | 最短 1；最长 2000                       |

成功：HTTP 202，`{ data: Publication, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型             | 含义                                                |
| --------- | ---------------- | --------------------------------------------------- |
| operation | PublishOperation | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| task      | TaskDetail       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：P12。审计：publication.retry_requested。验收：AC-06、AC-07、AC-14（关联设计，不表示已验收）。

## listMemories

`GET /api/v1/memories` — 按类型、用途、状态查询记忆。

权限：admin / operator。

前置条件与业务校验：服务端团队隔离；creation 仅 active 非候选且范围适用，冲突用途筛选返回 422；每次按业务库当前版本复核；deleted 仅 management 返回无正文 tombstone。

查询参数（未列字段拒绝）：

| 字段      | 必填 | 类型                                                                      | 校验                                    |
| --------- | ---- | ------------------------------------------------------------------------- | --------------------------------------- |
| cursor    | 否   | string                                                                    | 最短 1；最长 512                        |
| limit     | 否   | integer                                                                   | 最小 1；最大 100                        |
| accountId | 是   | string                                                                    | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| purpose   | 是   | "creation" / "reflection" / "experiment" / "management"                   | 见业务前置条件                          |
| type      | 否   | "account_preference" / "task_fact" / "candidate" / "confirmed_experience" | 见业务前置条件                          |
| status    | 否   | "active" / "disabled" / "deleted"                                         | 见业务前置条件                          |

成功：HTTP 200，`{ data: Memories, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | Memory[]      | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：memory.queried（仅记录用途/引用）。验收：AC-09、AC-10（关联设计，不表示已验收）。

## getMemory

`GET /api/v1/memories/:memoryId` — 记忆详情与来源。

权限：admin / operator。

前置条件与业务校验：同团队；已删除返回 tombstone、body=null，无恢复操作。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Memory, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                      | 含义                                                |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| id                 | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| teamId             | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| accountId          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| type               | "account_preference" / "task_fact" / "candidate" / "confirmed_experience" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| body               | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| version            | number                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status             | "active" / "disabled" / "deleted"                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| scope              | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceTaskId       | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceVersionId    | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceReflectionId | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceCandidateId  | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| evidenceRefs       | SourceRef[]                                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| uncertainties      | string[]                                                                  | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmedBy        | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmedAt        | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmationReason | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncStatus         | "running" / "failed" / "pending" / "succeeded"                            | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| deletedAt          | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedAt          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-09（关联设计，不表示已验收）。

## editMemory

`PATCH /api/v1/memories/:memoryId` — 编辑记忆，创建新业务版本。

权限：admin / operator。

前置条件与业务校验：active/disabled；版本匹配；不允许直接改 type/确认信息；编辑不改变候选类型或自动创建正式策略；已确认经验范围不得超出已有人工确认范围；旧索引版本不能召回。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型    | 校验                          |
| --------------- | ---- | ------- | ----------------------------- |
| expectedVersion | 是   | integer | 最小 1；最大 9007199254740991 |
| body            | 是   | string  | 最短 1；最长 10000            |
| scope           | 是   | string  | 最短 1；最长 1000             |
| reason          | 是   | string  | 最短 1；最长 2000             |

成功：HTTP 200，`{ data: MemoryMutation, meta: { requestId, replayed } }`。data 字段：

| 字段    | 类型          | 含义                                                |
| ------- | ------------- | --------------------------------------------------- |
| memory  | Memory        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncJob | MemorySyncJob | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：M05。审计：memory.edited。验收：AC-09（关联设计，不表示已验收）。

## setMemoryAvailability

`POST /api/v1/memories/:memoryId/availability` — 明确禁用或启用记忆。

权限：admin / operator。

前置条件与业务校验：未 deleted；匹配版本；立即按新可用性过滤；启用不升级候选；同状态返回原对象不建多余同步。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型                  | 校验                          |
| --------------- | ---- | --------------------- | ----------------------------- |
| expectedVersion | 是   | integer               | 最小 1；最大 9007199254740991 |
| status          | 是   | "active" / "disabled" | 见业务前置条件                |
| reason          | 是   | string                | 最短 1；最长 2000             |

成功：HTTP 200，`{ data: MemoryMutation, meta: { requestId, replayed } }`。data 字段：

| 字段    | 类型          | 含义                                                |
| ------- | ------------- | --------------------------------------------------- |
| memory  | Memory        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncJob | MemorySyncJob | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：M03、M04。审计：memory.availability_changed。验收：AC-09（关联设计，不表示已验收）。

## deleteMemory

`DELETE /api/v1/memories/:memoryId` — 删除记忆并立即停止召回。

权限：admin / operator。

前置条件与业务校验：人工确认且版本匹配；原子 tombstone + 清理意图，立即 body=null、阻断召回；无回收站。相同幂等请求重放；已删除的新请求返回 tombstone 与原清理任务。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型    | 校验                          |
| --------------- | ---- | ------- | ----------------------------- |
| expectedVersion | 是   | integer | 最小 1；最大 9007199254740991 |
| confirmed       | 是   | true    | 见业务前置条件                |
| reason          | 是   | string  | 最短 1；最长 2000             |

成功：HTTP 200，`{ data: MemoryMutation, meta: { requestId, replayed } }`。data 字段：

| 字段    | 类型          | 含义                                                |
| ------- | ------------- | --------------------------------------------------- |
| memory  | Memory        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncJob | MemorySyncJob | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：M06。审计：memory.deleted（无正文）。验收：AC-09（关联设计，不表示已验收）。

## confirmMemory

`POST /api/v1/memories/:memoryId/confirmations` — 人工确认候选，创建独立已确认经验。

权限：admin / operator。

前置条件与业务校验：候选 active；证据/范围明确；保留原候选，以(sourceCandidateId,candidateVersion)防重；不自动更改正式配置。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型     | 校验                          |
| --------------- | ---- | -------- | ----------------------------- |
| expectedVersion | 是   | integer  | 最小 1；最大 9007199254740991 |
| reason          | 是   | string   | 最短 1；最长 2000             |
| scope           | 是   | string   | 最短 1；最长 1000             |
| evidenceIds     | 是   | string[] | 最少项 1；最多项 100          |

成功：HTTP 201，`{ data: ConfirmedMemory, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型          | 含义                                                |
| --------- | ------------- | --------------------------------------------------- |
| candidate | Memory        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmed | Memory        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncJob   | MemorySyncJob | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：M02。审计：memory.confirmed。验收：AC-09、AC-12（关联设计，不表示已验收）。

## listMemorySync

`GET /api/v1/memories/:memoryId/sync-jobs` — 受管同步/清理状态与失败范围。

权限：admin / operator。

前置条件与业务校验：deleted 也可查；失败可见；不宣称外部所有历史已清除。

路径字段：`memoryId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: SyncJobs, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型            | 含义                            |
| ---------- | --------------- | ------------------------------- |
| items      | MemorySyncJob[] | 当前分页结果                    |
| nextCursor | null / string   | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-09（关联设计，不表示已验收）。

## retryMemorySync

`POST /api/v1/memories/:memoryId/sync-jobs/:jobId/retry` — 重试失败的同步/清理。

权限：admin / operator。

前置条件与业务校验：job failed 且 targetVersion=当前版本；复用 job，attemptCount 增加；旧版本 409，不复活已删除内容。

路径字段：`memoryId`、`jobId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型    | 校验                          |
| --------------- | ---- | ------- | ----------------------------- |
| expectedVersion | 是   | integer | 最小 1；最大 9007199254740991 |

成功：HTTP 202，`{ data: SyncJob, meta: { requestId, replayed } }`。data 字段：

| 字段          | 类型                                           | 含义                                                |
| ------------- | ---------------------------------------------- | --------------------------------------------------- |
| id            | string                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| memoryId      | string                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| targetVersion | number                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| action        | "delete" / "upsert" / "disable"                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status        | "running" / "failed" / "pending" / "succeeded" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| targetScopes  | string[]                                       | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptCount  | number                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| lastError     | null / object                                  | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt     | string                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt    | null / string                                  | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：M09。审计：memory.sync_retried。验收：AC-09（关联设计，不表示已验收）。

## createReflection

`POST /api/v1/tasks/:taskId/reflections` — 手动触发复盘。

权限：admin / operator。

前置条件与业务校验：尝试已结束；无工作槽、未决发布或同任务 processing 复盘；允许 terminated/published；冻结所选尝试的版本及证据，产出前失败时 contentVersionId 显式 null 并引用失败证据；不占用发布资格。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型          | 校验                                    |
| ---------------- | ---- | ------------- | --------------------------------------- |
| expectedRevision | 是   | integer       | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string / null | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| attemptId        | 是   | string        | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| evidenceIds      | 是   | string[]      | 最少项 1；最多项 100                    |

成功：HTTP 202，`{ data: Reflection, meta: { requestId, replayed } }`。data 字段：

| 字段                    | 类型                                  | 含义                                                |
| ----------------------- | ------------------------------------- | --------------------------------------------------- |
| id                      | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId                  | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptId               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| retryOfReflectionId     | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status                  | "failed" / "completed" / "processing" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| requestedBy             | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| inputSnapshotRefs       | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| evidenceRefs            | SourceRef[]                           | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| observations            | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| hypotheses              | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| alternativeExplanations | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| suggestedValidation     | object[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| uncertainties           | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| candidateMemoryIds      | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| error                   | null / object                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt              | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：F01。审计：reflection.requested。验收：AC-12（关联设计，不表示已验收）。

## listReflections

`GET /api/v1/tasks/:taskId/reflections` — 复盘历史。

权限：admin / operator。

前置条件与业务校验：同任务；新复盘不覆盖旧结论。

路径字段：`taskId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: Reflections, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | Reflection[]  | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-12（关联设计，不表示已验收）。

## getReflection

`GET /api/v1/tasks/:taskId/reflections/:reflectionId` — 证据、观察、假设与不确定性。

权限：admin / operator。

前置条件与业务校验：同任务；明确区分证据与推测。

路径字段：`taskId`、`reflectionId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Reflection, meta: { requestId, replayed } }`。data 字段：

| 字段                    | 类型                                  | 含义                                                |
| ----------------------- | ------------------------------------- | --------------------------------------------------- |
| id                      | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId                  | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptId               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| retryOfReflectionId     | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status                  | "failed" / "completed" / "processing" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| requestedBy             | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| inputSnapshotRefs       | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| evidenceRefs            | SourceRef[]                           | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| observations            | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| hypotheses              | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| alternativeExplanations | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| suggestedValidation     | object[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| uncertainties           | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| candidateMemoryIds      | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| error                   | null / object                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt              | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-10、AC-12（关联设计，不表示已验收）。

## retryReflection

`POST /api/v1/tasks/:taskId/reflections/:reflectionId/retries` — 再次复盘，新建关联记录。

权限：admin / operator。

前置条件与业务校验：旧复盘 failed/completed；满足 F01；新记录 retryOfReflectionId；无同任务并行复盘。

路径字段：`taskId`、`reflectionId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段             | 必填 | 类型          | 校验                                    |
| ---------------- | ---- | ------------- | --------------------------------------- |
| expectedRevision | 是   | integer       | 最小 1；最大 9007199254740991           |
| contentVersionId | 是   | string / null | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| evidenceIds      | 是   | string[]      | 最少项 1；最多项 100                    |

成功：HTTP 202，`{ data: Reflection, meta: { requestId, replayed } }`。data 字段：

| 字段                    | 类型                                  | 含义                                                |
| ----------------------- | ------------------------------------- | --------------------------------------------------- |
| id                      | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| taskId                  | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| attemptId               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| retryOfReflectionId     | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status                  | "failed" / "completed" / "processing" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| requestedBy             | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| inputSnapshotRefs       | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| evidenceRefs            | SourceRef[]                           | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| observations            | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| hypotheses              | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| alternativeExplanations | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| suggestedValidation     | object[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| uncertainties           | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| candidateMemoryIds      | string[]                              | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| error                   | null / object                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt               | string                                | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| finishedAt              | null / string                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：F04。审计：reflection.retried。验收：AC-12（关联设计，不表示已验收）。

## saveCandidate

`POST /api/v1/tasks/:taskId/reflections/:reflectionId/candidates` — 把复盘建议保存为候选经验。

权限：admin / operator。

前置条件与业务校验：复盘 completed、建议属于本复盘；冻结原建议/证据/不确定性；唯一(reflectionId,suggestionId)；不创建正式策略。

路径字段：`taskId`、`reflectionId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段         | 必填 | 类型   | 校验                                    |
| ------------ | ---- | ------ | --------------------------------------- |
| suggestionId | 是   | string | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |

成功：HTTP 201，`{ data: Memory, meta: { requestId, replayed } }`。data 字段：

| 字段               | 类型                                                                      | 含义                                                |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| id                 | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| teamId             | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| accountId          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| type               | "account_preference" / "task_fact" / "candidate" / "confirmed_experience" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| body               | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| version            | number                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status             | "active" / "disabled" / "deleted"                                         | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| scope              | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceTaskId       | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceVersionId    | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceReflectionId | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sourceCandidateId  | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| evidenceRefs       | SourceRef[]                                                               | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| uncertainties      | string[]                                                                  | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmedBy        | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmedAt        | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| confirmationReason | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| syncStatus         | "running" / "failed" / "pending" / "succeeded"                            | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| deletedAt          | null / string                                                             | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| createdAt          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedAt          | string                                                                    | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：F05、M01。审计：memory.candidate_saved。验收：AC-09、AC-12（关联设计，不表示已验收）。

## getConfig

`GET /api/v1/config` — 读取无密钥配置及版本。

权限：admin。

前置条件与业务校验：仅管理员；不含凭据；maxAutoRevisions 固定 3。

成功：HTTP 200，`{ data: Config, meta: { requestId, replayed } }`。data 字段：

| 字段             | 类型     | 含义                                                |
| ---------------- | -------- | --------------------------------------------------- |
| version          | number   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| accountId        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| profile          | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| tone             | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| forbiddenTopics  | string[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| rules            | object[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| modelRef         | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| promptVersion    | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| toolVersion      | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| maxAutoRevisions | 3        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedBy        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedAt        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：config.read。验收：AC-08、AC-10（关联设计，不表示已验收）。

## updateConfig

`PUT /api/v1/config` — 保存完整配置新版本。

权限：admin。

前置条件与业务校验：仅管理员，版本匹配，服务端追加版本；运行尝试保留快照；基础规则变化须重验现有审核/批准，不满足则 A06，发布入口使用当前规则。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段                  | 必填 | 类型     | 校验                                    |
| --------------------- | ---- | -------- | --------------------------------------- |
| expectedVersion       | 是   | integer  | 最小 1；最大 9007199254740991           |
| profile               | 是   | string   | 最短 1；最长 4000                       |
| tone                  | 是   | string   | 最短 1；最长 1000                       |
| forbiddenTopics       | 是   | string[] | 最少项 0；最多项 100                    |
| rules                 | 是   | object[] | 最少项 0；最多项 100                    |
| rules[].id            | 是   | string   | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| rules[].description   | 是   | string   | 最短 1；最长 1000                       |
| rules[].deterministic | 是   | boolean  | 见业务前置条件                          |
| modelRef              | 是   | string   | 最短 1；最长 128                        |
| promptVersion         | 是   | string   | 最短 1；最长 128                        |
| toolVersion           | 是   | string   | 最短 1；最长 128                        |
| reason                | 是   | string   | 最短 1；最长 2000                       |

成功：HTTP 200，`{ data: Config, meta: { requestId, replayed } }`。data 字段：

| 字段             | 类型     | 含义                                                |
| ---------------- | -------- | --------------------------------------------------- |
| version          | number   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| accountId        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| profile          | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| tone             | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| forbiddenTopics  | string[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| rules            | object[] | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| modelRef         | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| promptVersion    | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| toolVersion      | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| maxAutoRevisions | 3        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedBy        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| updatedAt        | string   | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：A06。审计：config.updated。验收：AC-05、AC-08、AC-10（关联设计，不表示已验收）。

## listExperiments

`GET /api/v1/experiments` — 离线实验摘要。

权限：admin / operator。

前置条件与业务校验：同团队；含失败样本/成本/限制；不推定多 Agent 必胜。

查询参数（未列字段拒绝）：

| 字段   | 必填 | 类型    | 校验             |
| ------ | ---- | ------- | ---------------- |
| cursor | 否   | string  | 最短 1；最长 512 |
| limit  | 否   | integer | 最小 1；最大 100 |

成功：HTTP 200，`{ data: Experiments, meta: { requestId, replayed } }`。data 字段：

| 字段       | 类型          | 含义                            |
| ---------- | ------------- | ------------------------------- |
| items      | Experiment[]  | 当前分页结果                    |
| nextCursor | null / string | 下一页不透明游标，null 表示结束 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-13（关联设计，不表示已验收）。

## runExperiment

`POST /api/v1/experiments` — 运行已配置离线实验。

权限：admin / operator。

前置条件与业务校验：冻结配置与数据集；独立实验执行上下文，无真实发布凭据/工具；结果仅 SimulationRecord，不能改实际任务发布状态。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段           | 必填 | 类型    | 校验                          |
| -------------- | ---- | ------- | ----------------------------- |
| configVersion  | 是   | integer | 最小 1；最大 9007199254740991 |
| datasetVersion | 是   | string  | 最短 1；最长 128              |
| offline        | 是   | true    | 见业务前置条件                |

成功：HTTP 202，`{ data: Experiment, meta: { requestId, replayed } }`。data 字段：

| 字段              | 类型                                          | 含义                                                |
| ----------------- | --------------------------------------------- | --------------------------------------------------- |
| id                | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| title             | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status            | "queued" / "running" / "failed" / "completed" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| configVersion     | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| datasetVersion    | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| offline           | true                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sampleCount       | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| failedSampleCount | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| quality           | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| cost              | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| durationMs        | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| limitations       | string[]                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| traceUrl          | null / string                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：experiment.requested。验收：AC-13（关联设计，不表示已验收）。

## getExperiment

`GET /api/v1/experiments/:experimentId` — 实验摘要及 Langfuse 链接。

权限：admin / operator。

前置条件与业务校验：同团队；外链权限由 Langfuse 独立管理；盲评前不暴露分组信息。

路径字段：`experimentId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: Experiment, meta: { requestId, replayed } }`。data 字段：

| 字段              | 类型                                          | 含义                                                |
| ----------------- | --------------------------------------------- | --------------------------------------------------- |
| id                | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| title             | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| status            | "queued" / "running" / "failed" / "completed" | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| configVersion     | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| datasetVersion    | string                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| offline           | true                                          | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| sampleCount       | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| failedSampleCount | number                                        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| quality           | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| cost              | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| durationMs        | null / number                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| limitations       | string[]                                      | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| traceUrl          | null / string                                 | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：访问日志。验收：AC-10、AC-11、AC-13（关联设计，不表示已验收）。

## nextBlindItem

`GET /api/v1/experiments/:experimentId/blind-items/next` — 读取当前成员未评分的匿名样本。

权限：admin / operator。

前置条件与业务校验：实验有可评样本；按成员固定随机顺序计算下一未评分项，GET 不写分配状态；分组/模型/策略/轨迹隐藏；同一未提交样本重复读取相同。

路径字段：`experimentId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

成功：HTTP 200，`{ data: BlindItem, meta: { requestId, replayed } }`。data 字段：

| 字段      | 类型          | 含义                                                |
| --------- | ------------- | --------------------------------------------------- |
| item      | null / object | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| remaining | number        | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：只读，可重试；分页使用不透明游标。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：evaluation.item_viewed。验收：AC-13（关联设计，不表示已验收）。

## submitBlindScore

`POST /api/v1/experiments/:experimentId/blind-scores` — 提交人工盲评。

权限：admin / operator。

前置条件与业务校验：样本归属本成员会话，choice 属于 item；唯一(memberId,itemId)，不能用新请求覆盖旧分；版本冲突 409。

路径字段：`experimentId` 均必填，为 1—128 位不透明 ID，仅字母、数字、下划线、连字符；逐级校验对象同属团队/任务。

请求头：Idempotency-Key 必填，16—128 字符；X-CSRF-Token 必填（已过期退出会话例外）。

JSON 请求体（未列字段拒绝）：

| 字段            | 必填 | 类型    | 校验                                    |
| --------------- | ---- | ------- | --------------------------------------- |
| itemId          | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| expectedVersion | 是   | integer | 最小 1；最大 9007199254740991           |
| choiceId        | 是   | string  | 最短 1；最长 128；匹配 ^[A-Za-z0-9_-]+$ |
| score           | 是   | integer | 最小 1；最大 5                          |
| reason          | 是   | string  | 最短 1；最长 2000                       |

成功：HTTP 201，`{ data: BlindScore, meta: { requestId, replayed } }`。data 字段：

| 字段        | 类型   | 含义                                                |
| ----------- | ------ | --------------------------------------------------- |
| id          | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| itemId      | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |
| submittedAt | string | 同名共享对象字段，见核心对象设计与 OpenAPI 完整结构 |

重复与并发：须 Idempotency-Key；同键同请求重放原结果，同键不同请求 409；不同键仍校验资源唯一性。

超时与失败：遵循 [统一故障协议](api-contract.md#故障与冲突协议)；发布相关写入不自动重发。错误体始终为 ApiError；所有未满足前置条件的操作保持业务原状态。

转换：无业务状态转换。审计：evaluation.scored。验收：AC-13（关联设计，不表示已验收）。
