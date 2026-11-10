# D9 共享研究命令与三组原子事务

2026-11-10 更新：Research 执行链与最小页面已完成接线及离线验证，见[验收与启用方案](../acceptance/d9-backend-agent-pr-2026-11-10.md)。业务迁移与真实付费调用尚未执行。

2026-11-09，Asia/Shanghai。依据[用户决定](../design/d9-selection-research-authorization.md)和[接口与事务设计](../design/d9-research-api-transactions.md)，本批实现用户在每轮研究前的命令入口及持久化，尚未接通实际 Research 执行。

## 已实现的行为

| 命令                                  | 路径（前缀 `/api/v1`）                         | 原子内容                                                                                                 |
| ------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `selectProjectAndAuthorizeResearch`   | `POST /tasks/:taskId/project-selection`        | 选题、initial 未消耗授权、Supervisor 排队、revision、审计与幂等响应                                      |
| `retryResearchAndAuthorize`           | `POST /tasks/:taskId/research-attempt-retries` | 新 attempt、新 initial 授权、task 指针与 generation、旧批准失效/内容及审核指针清除、排队、审计与幂等响应 |
| `submitMaterialsAndAuthorizeResearch` | `POST /tasks/:taskId/research-supplements`     | 可空资料批次、资料版本及确认、绑定最新报告的 supplement 授权、排队、revision、审计与幂等响应             |

共享请求 Zod Schema 是 HTTP JSON Schema 的来源，服务内部再次解析；三个成功响应统一为 `ResearchCommandResult`，保留已有 Research 报告及上下文结构。公开 OpenAPI、生成的请求类型、响应 Schema 和接口参考已同步。生成器补齐 `anyOf` 请求类型的联合输出，粘贴文本和链接可正确表示为 `string | null`。

明确授权必须是 JSON 字面量 true，拒绝字符串 `"true"`、未知问题输入、操作者/策略/执行权伪造字段。沿用 Session、Origin/CSRF、active 成员/团队/账号归属、revision 和发布锁。取 task/attempt/step/authorization/budget 锁后完成所有写入；同键重传读取原提交快照，同键异内容冲突，换键仍受业务唯一约束。版本冲突返回现有 ApiError.conflict 字段。

用户确认的 **1A、2A** 已落实：新 attempt 不带旧报告、旧补交资料或官网范围，保留旧历史并复用原选题/榜单；补查仅选择本 attempt 最新采用报告已有的问题／关联缺口，不支持新增问题字段。无新资料的明确问题补查合法。任务预算只读取和冻结引用，不重建、不归零；旧重试入口对已选题 agent 明确拒绝。

资料正文保留原样，新用户文本生成宿主材料 ID/哈希；纯链接只登记线索。确认绑定 Session 成员、数据库时间与精确材料版本；已有材料确认生成新快照 ID 和递增版本，旧材料及报告保持原样。每次请求的官网范围独立登记，不从历史合并或推断；规范化 origin/路径并拒绝路径穿越、编码歧义、凭据和非标准端口。

传输保护：请求体 1 MiB；新资料最多 20 条、每条文本最多 20,000 字符、一次文本总量最多 100,000 字符；确认和官网范围各最多 20 项；问题/缺口各最多 100 项。它们不改变模型或工具调用额度。

任务详情增加可选 research 摘要和三个 actions，并可通过原选择读取跨 attempt 的原榜单。未接通 Research 时 actions 禁用；正式 composition root 不提供研究策略，三个命令返回 `503 DEPENDENCY_UNAVAILABLE` 且不写入选题、资料、授权或新 attempt。离线验收通过显式依赖注入启用事务服务，没有新增环境变量或 HTTP 绕过开关。

## 新增迁移与隔离范围

`0015_d9_research_commands` 新增 `research_submissions`、`research_submission_materials`，为 registry 增加非负版本号。新表复合外键绑定 task/attempt/授权/基版；正文哈希、资料形态、一手确认及谱系版本通过约束保护。INSERT 检查当前开放 agent attempt 与待用授权；历史 UPDATE/DELETE 拒绝。延迟约束在提交时要求新 supplement 授权对应资料批次，并核对 scope 材料引用与持久化材料集合；零材料批次仍合法。

scope 同时冻结提交记录总数，提交时核对全部记录（含仅链接线索）与正文材料引用；提交成功后不能再追加材料或线索。新增 registry 触发器保留 v14 的当前运行与登记归属检查，并允许显式递增 registryRevision。旧版登记 revision=0 保持兼容；私有登记接口仍待实现。

**未应用到现有业务库。** 验收另建了临时 PostgreSQL 容器，使用本机已缓存的 `pgvector/pgvector:0.8.7-pg16-bookworm`，仅绑定 loopback 随机端口，无业务卷。脚本创建随机临时数据库和权限受限运行角色，应用迁移后以普通运行角色调用真实 HTTP 路由和事务服务；结束清理临时库及角色，完成检查后移除容器。未调整业务账号权限或修改用户 `.env`，未请求模型、搜索、XXAPI 或外部官网。

既有 `0014` SQL SHA-256 仍为 `c54ed9ff0939e8da6a09533f2d64e13e6dba206ecc27b63ed4762f1d6a98ad63`，没有回改已应用迁移。

## 验证

`scripts/research-commands.test.mjs` 为真实 PostgreSQL/事务/约束和 Session 路由验收，注入的只是 Research 能力配置；不运行 SDK。15 项覆盖：

1. 选题与授权/排队一起提交，同键并发返回同一授权和原响应。
2. 不同键并发选题仅一次成功，最终写入故障全部回滚，同键随后可重试。
3. 并发 retry 仅一个新 attempt，原榜单/选题/累计预算保留，旧资料/官网/报告不继承。
4. retry 中途失败恢复原 attempt 和 task 指针。
5. 零资料补查创建空批次及待用授权，不提前消耗。
6. 粘贴原文、一手确认、链接线索和已有资料新版本正确持久化，历史不可覆盖。
7. 补交失败全部回滚；旧基版、未知问题/缺口、错误确认哈希不产生部分提交。
8. 同基版并发补查只创建一份待用授权。
9. 未就绪的三个命令全部拒绝且零业务写入，鉴权优先。
10. 旧 retry、越 attempt 榜单、取消状态和耗尽预算不能绕过。
11. 停止与选题并发按任务事务串行化。
12. 原始 JSON 类型、CSRF 和 revision 冲突信息正确。
13. 跨团队拒绝，身份撤销后不重放成功响应。
14. 数据库提交时拒绝孤立的 supplement 授权。
15. 旧批准失效和指针清除与 retry 同事务，失败恢复原批准。

四项新增共享测试另覆盖请求授权与未知字段、无资料与链接确认、官网路径规范化、正文保留和总量限制。CI 的隔离 PostgreSQL 任务已加入 `npm run research-commands:test`，需要显式 `RESEARCH_TEST_ADMIN_URL`，脚本不读取业务环境。

原有独立 Supervisor 服务的 5 项隔离库/回环 HTTP 流程也已回归通过，与本批 15 项合计 20 项数据库集成验收通过。免费检查：共享契约一致性、全工作区类型检查、`npm test`（190 项）、四工作区构建、改动源码 ESLint/Prettier、`git diff --check`。Drizzle 再次生成显示无结构差异。前端构建保留约 519 kB 主包提示。

## 后续边界

本批没有实现 Research 私有回调、实际分派时的授权消耗、逐次出站权限/额度、报告解析纠正和校验后入库，也没有新增研究页面或开启真实供应商调用。当前后端/Agent 服务仍明确阻断 Research；不能把三个事务通过视为 Supervisor → Research 已连通。

接通执行链并完成离线验收后，才能在正式启动处装配受控研究策略；当前无环境开关可直接启用。官网逐跳访问控制、计价版本及 SDK 美元限额仍须按既有决定处理。现有业务库应用 `0015` 需另行完成目标库、备份、停旧执行器与迁移安排。
