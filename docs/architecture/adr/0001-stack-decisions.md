# ADR 0001：第一阶段登录、模型、搜索与数据库访问选型

- 决策日期：2026-10-27。
- 状态：D2 选型结论；随本 PR 评审、合并生效。四项均已有实施基线，接通与功能验证尚未完成。
- 需求依据：[PRD V1.0](../../product/PRD-V1.0.md) 第 2、4.2、8、10、13 章。
- 范围：单团队、单微博账号、纯文案、人工批准发布；沿用 TypeScript、Fastify、PostgreSQL、Claude Agent SDK 和 Langfuse Cloud。
- 本次仅完成块 B 的文档决策；不提交微博申请，不创建块 C 的里程碑或 Issues，不安装业务依赖、不调用付费服务。

## 决策摘要

| 决策 | 结论                                                                          | 实施与验证状态                      |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------- |
| 登录 | 本地成员账号 + 短期 JWT access token + 可轮换的 opaque refresh token          | 未实现；B-AUTH 验证                 |
| 模型 | Anthropic 官方 API；Claude Agent SDK TypeScript；基线模型 `claude-sonnet-5-5` | 未接通；B-LLM 验证账号与 SDK 兼容性 |
| 搜索 | Tavily Search API，通过官方 `@tavily/core` 封装只读工具                       | 未接通；B-SEARCH 验证中文来源与额度 |
| ORM  | Drizzle ORM + 现有 `pg` 驱动 + Drizzle Kit SQL 迁移                           | 未实现；B-ORM 验证迁移与事务        |

“选型已确定”不等于“服务已可用”。SDK 版本在接入 PR 中经兼容性检查后锁定到根 `package-lock.json`；本 ADR 不虚构已安装版本、账号余额或测试结果。

## 1. 登录：JWT + 刷新 Token

### 决定

1. 首期由管理员创建内部成员，使用邮箱/账号与密码登录；不提供公开注册、社交登录或单点登录。密码使用 Argon2id 哈希，登录接口限流，失败返回统一提示。
2. Fastify 使用兼容 v5 的 `@fastify/jwt`。access token 初始有效期 15 分钟，固定校验算法 HS256、签发者、受众、到期时间；签名密钥至少 32 个随机字节，只在服务端提供。
3. JWT 最小包含成员 ID、团队 ID、会话 ID、签发和到期时间。浏览器仅在内存保存 access token，以 `Authorization: Bearer` 调用 API，不将登录凭据写入 localStorage 或日志。
4. refresh token 使用至少 32 个随机字节生成的不透明值，数据库只保存 SHA-256 摘要、成员/会话、token family、到期与撤销记录。会话绝对有效期初始为 7 天；轮换不得无限延长该期限。
5. refresh token 放在 `HttpOnly; Secure; SameSite=Lax` Cookie，Path 限制为 `/api/auth`。生产前后端使用同源 HTTPS；本地 HTTP 开发才允许关闭 Secure，生产缺少安全配置时拒绝启动。
6. 刷新在事务中一次性消费旧 token 并签发新 token；旧 token 重放撤销整个 family。前端对刷新请求做单次并发合并，避免多个请求同时轮换。
7. 刷新与退出等 Cookie 认证接口校验可信 Origin，并采用 CSRF token 防护。CORS 只允许显式来源，不使用携带凭据的通配符配置。
8. 退出、成员禁用、改密撤销相应会话；每次业务请求在服务端核对会话、成员状态与当前角色，保证撤销和权限变更立即生效。前端隐藏按钮或 JWT 内的旧角色不能代替授权检查。

15 分钟和 7 天是初始安全配置，可配置并留痕；它们不代表已测得的性能或业务预算。签名密钥轮换会使旧 access token 失效，保留刷新会话的轮换策略由鉴权实现 PR 验证。

### 理由与替代方案

与当前 Fastify 和 PostgreSQL 直接结合，满足两名内部成员及管理员/运营人员权限，不引入额外身份服务运维。服务端会话查询增加一次数据库访问，首期接受这一成本以实现立即撤销。

Keycloak/完整外部 IdP 后置到出现企业 SSO、跨系统账号治理需求时；纯服务端 Cookie session 也是可行替代，但本次统一采用 JWT + refresh token，避免两套登录机制并存。JWT 不代替 PRD 中的发布批准、版本和账号校验。

## 2. 模型：Anthropic 官方 API + Claude Agent SDK

### 决定

- 通过服务端 `ANTHROPIC_API_KEY` 使用 Anthropic 官方 API；Agent 使用官方 TypeScript `@anthropic-ai/claude-agent-sdk`。不把个人聊天订阅视作项目 API 额度，也不默认兼容第三方转发地址。
- 四个核心角色及单 Agent 对照基线统一使用 `claude-sonnet-5-5`，将模型 ID 作为显式配置；此次选择优先控制首期写作与研究流程的复杂度和费用，实际中文质量仍需样例验证。
- 每次执行记录配置模型、响应中可获得的实际模型标识、SDK 版本、提示词/工具版本、Token、耗时及可获取的成本。不同模型不混为同一实验配置；不用 `latest` 或自动跨供应商降级。
- SDK 的工具按角色显式允许，并通过权限回调拒绝其余工具；不向 Agent 开放通用 shell、任意文件读写或真实发布凭据。Research 通过受控工具调用 Tavily；不同时启用内置 WebSearch，避免来源和费用口径混杂。
- API Key、可用地区、目标运行环境网络、账户额度、该模型与所锁 SDK 的结构化输出和工具调用兼容性，全部在 B-LLM 实测。官方列出模型不代表当前账号已获准调用。
- 模型不可用则明确标记接入受阻，保留模拟执行和人工流程开发；禁止把模拟结果作为真实调用结果。换模型/供应商须修订本 ADR 并重新验证，不在后台静默切换。

不选择全自研 Agent 循环或新的 Agent 框架，因为 PRD 已确定 Claude Agent SDK。Bedrock 等官方渠道可在直连因部署或账号约束不可用时另作决策，本次不增加云平台账号与认证链。

官方模型 ID 仍可能受供应商版本策略影响；记录配置与实际返回标识不保证模型输出或底层权重永远不变。正式实验前保存资料快照、配置、运行标识及重复计划。

## 3. 搜索：Tavily

### 决定

- 选 Tavily Search API；服务端通过官方 `@tavily/core` SDK 实现可替换的 `SearchProvider`，密钥仅在服务端。
- 首期使用 general/basic 搜索，每次最多返回 5 条结果，关闭自动参数升级与生成式答案，保留标题、URL、内容摘要、检索时间和服务请求标识（如提供）。这些是初始产品配置，不是质量或吞吐保证。
- 围绕用户给定主题检索，不持续监测热点；中文内容覆盖、来源质量、URL 可访问性和必要的正文提取在 B-SEARCH 验证。需要全文时可使用同供应商 Extract，并单独记录调用和费用。
- 资料按来源保存、去重并标注缺失日期；结果作为不可信资料传递，不能覆盖系统指令或审批规则。不得向搜索服务发送密钥或未脱敏的内部任务原文。
- 搜索额度耗尽、超时或失败时记录错误；证据不足进入人工补充资料流程，不伪造来源、不把缓存结果描述为最新检索。超时、重试和单任务预算数值在小样本验证后冻结。

Tavily 有官方 TypeScript SDK，能够集中维护搜索与后续提取。Exa 等服务保留为修订 ADR 时的替代候选；不同时接入多家，不用非官方搜索页面抓取作为默认降级。是否适合本项目中文场景以 B-SEARCH 结果为准。

## 4. ORM：Drizzle

### 决定

- 使用 `drizzle-orm`、`drizzle-kit` 和仓库已有 `pg`；数据库访问封装在服务端，前端不连接数据库。
- 使用轻量 TypeScript 表定义和接近 SQL 的查询，不引入额外 schema DSL。生成的 SQL 迁移入库评审；联调、共享和生产库通过迁移应用，不使用 schema push 绕过评审。
- 业务表迁移由后端统一维护；唯一约束、外键、版本比较及必要事务用于审批失效、发布防重等业务一致性。外部发布调用不能包在长事务中，也不能因数据库回滚自动重复发布。
- 数据库底层允许显式 SQL；Mem0 管理的检索表/历史存储与业务迁移分开，Drizzle 不接管 Mem0 私有表，详见 [ADR 0002](0002-memory.md)。
- 选择兼容 Node.js 24、现有 `pg` 的已发布稳定版本，接入时锁版本并检查 ORM/迁移工具兼容；不为追逐文档示例自动采用 RC。暂不新增运行时依赖或迁移。

Kysely 同样轻量，但本项目还需要显式表定义和统一迁移约定，采用 Drizzle 减少另行组合的工作。Prisma 等重 schema DSL 方案不纳入首期；直接 `pg` 仅用于现有探针及明确的底层 SQL，不扩散为多套业务访问规范。

## 5. 实施前验证与责任边界

以下 ID 是本地验证清单，不是已经创建的 GitHub Issue。块 C 执行时再转为 Issues 并回填链接；负责方向由对应接入 PR 的认领人承担。

| ID       | 负责方向       | 最晚完成时点                   | 验收证据                                                                                                          | 当前状态       |
| -------- | -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| B-AUTH   | 后端/鉴权      | 团队联调前、鉴权实现 PR 合并前 | 登录与刷新成功；过期拒绝；重放撤销；退出/禁用立即失效；CSRF 与越权被拒；日志无凭据                                | 未实现、未验证 |
| B-LLM    | Agent/接入     | 真实 Agent 实现 PR 合并前      | 实际部署环境完成一条中文结构化输出和一次受控工具调用；记录版本、模型、耗时、Token、账户错误处理；默认危险工具被拒 | 未接通、未验证 |
| B-SEARCH | Agent/Research | Research 实现 PR 合并前        | 固定 3 个中文主题；保存每次结果与来源，标注可用性和质量；验证空结果、无效 Key、额度及超时处理                     | 未接通、未验证 |
| B-ORM    | 后端/持久化    | 首个业务表迁移 PR 合并前       | 全新库及已有 D1 库可迁移；持久卷不丢失；事务回滚和并发唯一约束可复现；现有健康检查通过                            | 未实现、未验证 |

API、后台执行器及数据库的共享运行环境、Langfuse Cloud 项目/地区、数据保留政策和正式实验预算仍按 PRD 第 13 章另行确定；本 ADR 的登录决策不代表部署环境已确定。数据进入外部服务前仍须完成相应账号与数据范围配置。

## 6. 官方依据

核对日期：2026-10-27。以下说明能力与接入方式，不代替本项目账号和环境验证。

- [Fastify JWT 插件](https://github.com/fastify/fastify-jwt)：JWT 接入及 Cookie/CSRF 注意事项。
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)：TypeScript Agent 运行时与工具/权限配置。
- [Claude 模型目录](https://platform.claude.com/docs/en/models/overview)：所选 Sonnet 模型 ID 与供应商能力说明。
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) 与 [官方 TypeScript SDK](https://github.com/tavily-ai/tavily-js)：搜索结果和接入方式。
- [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)、[事务](https://orm.drizzle.team/docs/transactions)与[迁移配置](https://orm.drizzle.team/docs/drizzle-config-file)：驱动、事务和迁移支持。
