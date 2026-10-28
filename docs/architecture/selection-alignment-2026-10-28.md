# 七项选型统一记录

2026-10-28（Asia/Shanghai）。统一基线见[最终七项技术选型](stack-decisions.md)。本次修订以 main 为基础准备主线 PR，并同步到 D1/D2 整合 PR #4；不改动已关闭 PR #2 的历史记录。

## 修改范围

- 明确服务端 Session / `ops_session` / 8 小时，登录仍未实现；保留 DeepSeek、Claude Agent SDK 和 WebSearch/WebFetch。
- 增加 Drizzle + pg 业务库连接、SQL 迁移生成与应用入口；业务表尚未实现，不生成虚构业务迁移。
- 保留 Mem0 OSS 3.3.1、`infer:false` 和 SQLite 历史，业务 Memory Manager 仍未实现。
- 将运行配置、SDK embedder、维度检查及新集合统一到官方 OpenAI text-embedding-3-small / 1536 维，拒绝旧 Ollama 和独立端口配置。
- 共用原 PostgreSQL Compose 服务与卷，独立业务/记忆数据库和非超级用户角色；显式管理身份创建角色/数据库与 vector 扩展。
- 更新 README、PRD、环境模板、架构与迁移说明。旧验证记录标为历史证据，不能用于证明新嵌入质量。
- 新增 `memory:check` 独立命令，检查实际角色隔离，并支持 1536 维测试向量及共享容器重建后的持久化检查。本次保留现有 CI 工作流定义；这些新数据库检查在隔离本地环境中执行，不配置外部 API Key、不产生真实调用费用。

## 主线修订验证

- 全新依赖安装 `npm ci --no-audit --no-fund` 成功；`npm ls openai zod --depth=1` 无无效 peer。根开发依赖显式固定 Zod 4，满足 Agent SDK；Mem0 内部仍使用自己的 Zod 3。
- `npm run check` 通过格式、Lint、类型、2 项后端测试、21 项 Agent 测试和所有工作区构建。
- `npm run test:e2e`：2 项浏览器测试通过。整合 PR 保留额外页面测试，结果在对应 PR 验证记录中跟踪。
- 隔离 Docker 测试项目/端口中验证 env:setup 首次业务角色创建、重复 setup 不覆盖配置、memory:setup、memory:check、db:check。
- 真实 PostgreSQL 中验证两个运行角色非超级用户、实际跨库连接被拒、vector 扩展可用；写入 1536 维测试向量，重建共享容器后读取成功。未接管本机既有业务/记忆容器或卷。
- `db:generate` 在无业务表时不生成迁移 SQL；空迁移元数据可应用到测试业务库，Drizzle/pg 实际查询通过。这不是业务表迁移验收。
- 使用本地 HTTP 嵌入桩验证真实 Mem0 3.3.1 的 OpenAI 1536 维请求契约、真实 pgvector 非超级用户读写/检索/删除及 SQLite 历史。此项是集成契约测试，不是真实 OpenAI 接通或语义质量验收。

本次没有调用真实 OpenAI、DeepSeek、搜索、Langfuse 或微博服务；OpenAI 账号、中文召回、业务治理和完整备份恢复仍按七项基线验证清单完成。锁定 Mem0 依赖链原有安全风险需后续处理，不通过降级 Mem0 或假验收隐藏。
