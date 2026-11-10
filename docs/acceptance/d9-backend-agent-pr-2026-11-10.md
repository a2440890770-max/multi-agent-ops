# D9 后端与 Supervisor／Research PR 范围

2026-11-10。比较基线为远程 `main`（`272d0c4`，已合并基础后台执行），提交分支为 `codex/supervisor-research-service`。本 PR 在独立工作目录中整理，不修改原工作区中其他未提交工作。

## 与远程仓库的差异

| 部分           | main             | 本 PR                                                           |
| -------------- | ---------------- | --------------------------------------------------------------- |
| 后端到 Agent   | 模拟执行为主     | 独立 HTTP Agent 服务、服务凭据、租约及取消控制                  |
| Supervisor     | 尚无本批业务接线 | 原生命名 Agent、任务理解、澄清、等待选题及研究交接              |
| Research       | 尚无受控执行闭环 | 一次性授权、受限网页来源登记、报告校验及版本采用                |
| 研究前人工命令 | 尚未实现         | 选题＋授权、新 attempt＋授权、提交资料＋补查授权原子提交        |
| 引用与诊断     | 尚未实现         | 共享 allowedReferences、StructuredOutput 工具、精确引用拒绝诊断 |
| 数据存储       | 到 0013          | 追加原有 0014、0015 及快照，运行时不自动迁移                    |

主要源码入口：`backend/src/server.ts`、`agent-task-executor.ts`、`research-command-service.ts`、`research-execution-service.ts`；`agent/src/service.ts`、`agents/supervisor/`、`agents/research/`；共享运行、报告、网页、授权及引用 Schema 在 `shared/src/schemas/`。两 Agent 的职责、权限和内部流程详见 `docs/architecture/supervisor.md`、`research-agent.md`、`research-web.md` 和 `agent-service.md`。

同一份 `buildAllowedReferences(context, results)` 生成起始提示的引用清单、Research 成功后的更新清单以及校验集合；Prompt 版本为 `supervisor-d9-v3`。主 Agent 明确提供 `StructuredOutput` 工具。SDK 调用失败时保留安全的校验阶段、错误码、字段路径和被拒绝引用；整段模型正文、凭据和原始 stderr 不写入诊断。

## 范围边界

本地另有 Review、Memory、账号平台迁移及前端研究界面工作，均不纳入本 PR。保留唯一必要的前端编译适配：为共享新增的三个等待状态增加中文标签。Research 媒体适配器和测试作为内部依赖纳入，但正式文本执行入口不开放视频工具。默认配置仍为 mock，Research 模板默认关闭。

不提交实际 `.env`、运行日志、备份、模型产物、凭据、Easel 或 portfolio-site。此 PR 不合并到 main，也不部署或调用付费供应商。既有 PR #11 包含早期 Supervisor／热榜实现，本 PR 对 main 提供完整的后端及受控研究接线，部分基础模块存在重叠。

## 验证与限制

独立 PR 工作目录已验证全工作区契约、格式、lint、类型、单元测试及构建；隔离 PostgreSQL／本地 HTTP 的 29 项 Agent 执行、研究原子命令及 Research 执行测试通过。Drizzle 检查与 0015 快照一致，无需新增迁移。隔离集成测试无需真实模型密钥。当前 GitHub 令牌缺少 workflow 权限，本 PR 沿用既有 CI，不新增工作流；集成测试已在本地完整执行并提供运行脚本。

实际联调曾验证后端 → Agent → Supervisor 的结构化输出与等待选题。最新 allowedReferences 提示通过离线和真实 SDK／本地模拟 API 验证；后续一次端到端尝试被前置热榜响应解析阻断，未启动模型。因此当前 Prompt 的真实供应商效果仍需单独验收；Research 供应商完整执行链尚未真实验收。不能将离线测试视为实际研究质量或供应商兼容性通过。
