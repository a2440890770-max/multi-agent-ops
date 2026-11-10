# D9 独立 Supervisor 服务接线验收

2026-11-09，Asia/Shanghai。范围：后端通过 HTTP 请求独立 Agent 服务，由该服务调用 `runSupervisor()`；先实现真实澄清和等待选题，Research 留待下一阶段。源码接线和离线闭环已通过；完整 SDK 的真实付费供应商调用仍未验收。

## 实现结果

- 后端 `AgentTaskExecutor` 复用任务、尝试、步骤、调用和预算表，负责领取、心跳、执行权、取消和最终提交。
- Agent 服务提供私有热榜和 Supervisor 执行接口，不连接业务数据库。服务间凭据与执行租约分别校验，输入快照做内容哈希核对。
- 数据库原子登记派发占用，同一调用不能因重复 HTTP 或 Agent 重启再次启动 SDK。保留每步骤最多一个 running call 的索引。
- 获取热榜后冻结上下文；Supervisor 输出 `needs_clarification` 或 `awaiting_selection`。等待释放租约、暂停活动时间；答复完整后在同 attempt 新增步骤，重新调用 Supervisor 判断语义，不重复抓榜。
- 一次 SDK 会话汇总模型用量和人民币配置口径的估算费用，只结算一次；缓存输入计入用量，未知用量保留预占。SDK 美元估算与供应商实际扣费不混同。
- 前端按运行模式显示真实/模拟操作，展示 API 候选、Supervisor 摘要、澄清及执行历史。当前不提供选题研究操作。

接口、配置和限制见[独立服务架构](../architecture/agent-service.md)。

## 免费检查

| 检查                                               | 结果                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run contract:check`                           | 通过，公开响应契约及接口文档一致                                      |
| `npm run typecheck`                                | 通过，包含 workspaces 和 E2E 类型检查                                 |
| `npm test`                                         | 186 项通过，0 失败、0 跳过：setup 5、shared 30、backend 22、agent 129 |
| `npm run build`                                    | 四个 workspace 构建通过；前端存在约 504 kB 主包的体积提示             |
| 本批改动文件 ESLint / Prettier、`git diff --check` | 通过                                                                  |
| 已保存的单次 XXAPI 响应离线业务解析                | 通过，9 个候选，没有新增网络请求                                      |

全量测试日志留在本机忽略目录 `artifacts/verification/d9-supervisor-offline-tests-2026-11-09.log`，没有提交凭据或完整供应商响应。

## 临时数据库与回环 HTTP 验收

`scripts/agent-execution.test.mjs` 使用真实 PostgreSQL 事务/约束、两个独立 HTTP 服务边界及真实 `runSupervisor()` 宿主实现；仅 SDK 传输和热榜获取注入离线样例。共 5 项通过：

1. 后端 → HTTP Agent → Supervisor；榜单、冻结输入、决定和模型汇总记账保存正确；等待不结束 attempt，并清空执行租约。
2. 非空但不足的答复仍进入新的 Supervisor 判断；再次澄清、最终等待选题，保留同 attempt 和答复历史，热榜只获取一次。
3. SDK 失败结束 attempt，不自动重试；用量未知保留预占，不编造成零费用。
4. 停止隔离旧代次并取消远端 SDK；迟到结果不写入；已登记的 begin 不可重复领取。
5. 空榜单保存可回查，并明确失败；模型调用次数为零。

最初本机账号无建库权限，未切换身份重试或提升权限。用户自行修改 `.env` 后，只读核对已具备建库及创建测试角色权限，再执行临时库方案。

每次验收创建独立 `agent_test_<随机后缀>` 数据库和非超级用户运行角色，应用既有迁移；结束后清理该临时库及角色。没有向业务库写入测试团队、成员、任务或榜单，也没有修改业务库结构及账号权限。

验收发现调用输入快照关联受既有不可变触发器保护，已修正为调用创建时写入；没有为通过测试而放宽约束或修改已应用迁移。`0014_d9_research_persistence.sql` SHA-256 仍为 `c54ed9ff0939e8da6a09533f2d64e13e6dba206ecc27b63ed4762f1d6a98ad63`。

## 真实请求与尚未验收项

- 用户此前允许的一次 DeepSeek 官方接口请求成功：HTTP 200，`deepseek-flash` 返回 `OK`，输入 13 / 输出 1 Token，约 0.84 秒，未重试。实际扣费金额未返回。这是直连接口检查，不是 SDK 全流程。
- 用户允许的一次 XXAPI 请求成功：业务码 200，9 个候选，字段 `title/desc/url`，未重试。后续只复用保存的响应。
- 本批其余检查均使用离线供应商传输；没有额外模型或 XXAPI 请求。没有验证真实模型的语义质量及 DeepSeek 与 SDK 结构化工具的完整兼容性。
- 没有自动切换本机 `TASK_EXECUTOR_MODE`。启用前仍需服务间密钥、版本化人民币计价和 SDK 美元预算；不代填供应商价格或汇率。
- Research 的选题授权、报告解析/纠正、工具/证据登记、视频 Skill 及 Content/Review/发布均不属于本批闭环。
