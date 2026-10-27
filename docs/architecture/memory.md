# D2 Mem0 内嵌接入

## 运行与存储

Mem0 OSS TypeScript SDK 直接嵌入 Agent。入口是 `agent/src/memory.ts` 的异步 `createProjectMemory()`；无需 Mem0 Cloud Key，不部署 Mem0 HTTP 服务。普通健康检查保持 D1 空壳行为。

| 组件       | 锁定选择                                                                       | 保存内容                                   |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Mem0 SDK   | `mem0ai@3.3.1`，入口 `mem0ai/oss`                                              | 在 Agent 进程执行记忆操作                  |
| PostgreSQL | PostgreSQL 16，`pgvector/pgvector:0.8.7-pg16-bookworm`，镜像摘要锁定在 Compose | 正文、768 维向量、元数据及嵌入配置锁定记录 |
| 嵌入模型   | 本机 Ollama `nomic-embed-text`，768 维                                         | 在本机把文本编码成向量                     |
| 历史存储   | Mem0 自带 SQLite，`better-sqlite3@12.10.0`                                     | Mem0 ADD/UPDATE/DELETE 等变更历史          |
| Node 驱动  | `pg@8.22.0`、`ollama@0.5.14`                                                   | 访问上述真实组件                           |

历史持久化是 D2 要求；使用 SQLite 是本次经用户确认的实现选择，并非 PRD 强制规定。SDK 历史不是业务审批、版本、确认人或操作审计的完整实现。PRD 4.6 所需的 Memory Manager、状态治理及同步失败处理仍需后续完成。

SDK 原生历史提供方为 SQLite、Supabase、内存；本次显式启用 SQLite，不使用临时内存历史。默认文件 `artifacts/memory/history.sqlite`，可通过 `MEM0_HISTORY_PATH` 指定仓库内或部署持久目录。部署和备份必须同时覆盖 PostgreSQL 持久卷及 SQLite 文件；不能只备份向量库。

SDK 在动态导入前关闭 `MEM0_TELEMETRY`，通过 `MEM0_DIR` 将身份/提示配置约束到当前仓库的 `artifacts/memory/sdk/`。这些数据和 `.env.memory` 均已被 Git 忽略。不创建用户主目录中的 Mem0 配置。

## 初始化与使用

```sh
npm ci
ollama pull nomic-embed-text
npm run memory:setup
npm run memory:verify -- --recreate-db
```

官方 DeepSeek Key 放在进程环境或已有 `.env`，不写入代码或报告。专用 `.env.memory` 保存记忆数据库随机凭据、嵌入模型、维度、集合与本地 Ollama 地址。通用业务 `DATABASE_URL` 不作为记忆地址的回退项。

Compose 项目 `multi-agent-ops-memory` 在 `127.0.0.1:55432` 启动独立 PostgreSQL 实例，数据库名 `agent_memory`，卷名 `multi-agent-ops-memory_memory_postgres_data`；它仍然是 PostgreSQL。当前另一份本地项目占用 5432，因此这里避免共用实例或改动其配置。若运行多份当前项目副本，需要分别配置 Compose 项目名、端口和数据卷。

SDK 使用方式示意（未来业务写入前仍须完成状态、来源与权限校验）：

```ts
import { createProjectMemory } from './memory.js';

const memory = await createProjectMemory();
const scope = 'team-example:weibo-example';
await memory.add('仅作技术示例的已确认偏好', {
  userId: scope,
  infer: false,
  metadata: { source: 'technical-example' },
});
const found = await memory.search('账号有什么偏好？', {
  filters: { user_id: scope },
  topK: 3,
});
```

此处 scope 演示技术隔离，不代替从已认证身份确定团队/账号范围。没有新增业务 HTTP 接口、页面或自动上下文注入。

## 模型调用边界

Agent 的推理仍使用已验证的 Claude Agent SDK → DeepSeek 官方 Anthropic 兼容接口。

Mem0 初始化要求提供 LLM 配置，即使调用 `add(..., { infer:false })`。因此配置中仍显式选择 DeepSeek 官方模型与官方地址，避免默认 OpenAI。当前测试与示例均使用 `infer:false`，真实生成嵌入、存储正文、检索向量，但不让 Mem0 自动提取/修改记忆，也不调用该 LLM。

若未来启用 Mem0 原生 `infer:true`，其内置 DeepSeek provider 会调用官方 Chat Completions，不经过 Claude Agent SDK；该路径本次未验证。若要坚持所有提取经过 Claude Agent SDK，应由现有结构化调用产生候选，经过业务确认后再以 `infer:false` 写入 Mem0。不得把候选自动启用。

## 嵌入配置锁定

初始化前先确认模型已在本机安装，并通过真实 embedding 调用验证维度。缺少模型时失败，不由 SDK 静默下载或更换模型。连接 PostgreSQL 时检查 pgvector 可用性；以 `mem0_embedding_profiles` 记录集合、模型、维度和实际 Ollama 模型摘要，重开时比对，避免混用同维度的不同模型。已有无锁定记录的向量表也拒绝直接接管。

默认集合 `mem0_ops_nomic_v1`。若切换 `bge-m3`，需先安装模型，配置 1024 维并选择新集合；历史数据应重新生成向量和迁移，不能直接更改旧向量列。当前选择用于 D2 技术连通性验证，不代表已证明中文业务检索质量。

## 验收与限制

`npm run memory:verify` 使用合成文本但不模拟嵌入、数据库或检索。所有阶段失败返回非零退出码，报告不覆盖旧文件。

1. 通过 SDK 写入目标偏好、无关干扰记忆和另一用户范围的记录。
2. 使用不同表述查询，要求第一条结果是目标记忆；空用户范围必须返回空结果。
3. 通过独立 PostgreSQL 连接核对正文、范围、实际向量维度和非零向量。
4. 分别使用 SDK `history()` 与独立 SQLite 读取核对 ADD 历史。
5. 退出写入进程，以新进程读取原记忆和历史，不重新写入。
6. 加上 `--recreate-db` 时重建专用 PostgreSQL 容器，再使用新进程读取；不删除数据卷。

真实报告记录运行时间、进程 ID、记忆 ID、维度、检索分数与历史行数，不记录模型 Key 或数据库密码。测试数据保留在专用测试范围中，未添加一键清库脚本。

SDK 3.3.1 没有公开的 `Memory.close()`；验证器使用隔离子进程，报告和同步 SQLite 写入完成后退出，由进程释放 SDK 的数据库连接。当前不使用私有字段、全局 factory 替换或修改 `node_modules`。

锁定环境安装时 `npm audit` 报告 3 项 high，来自 Mem0 内部 Zod 3 及其依赖链；推荐的自动修复会降级 Mem0 到 1.x，未擅自执行。接入阶段仅使用受限配置与合成测试数据；上线前应跟踪上游兼容修复、评估受影响输入路径并消除风险。没有用跨主版本强制覆盖来声称已修复。

Mem0 的 OpenAI 依赖带入 Node 18 类型声明，因此 Agent 的 TypeScript `typeRoots` 显式使用工作区根目录的 Node 24 类型；不更改模型客户端的运行时版本或强制覆盖上游依赖。

官方参考：[Mem0 仓库](https://github.com/mem0ai/mem0)、[Node SDK](https://docs.mem0.ai/open-source/node-quickstart)、[配置说明](https://docs.mem0.ai/open-source/configuration)。实际兼容性以本次锁定 npm 包源码及真实运行结果为准。
