# Mem0 内嵌接入与共享 PostgreSQL

当前基线见 [最终七项技术选型](stack-decisions.md)。2026-10-28 起使用 OpenAI 官方嵌入和同实例独立记忆数据库；2026-10-27 的 Ollama/独立实例报告保留为历史证据，不代表新方案的真实 API 验收。

## 组件与职责

| 组件                | 当前选择                                                            | 保存内容/职责                                     |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Mem0                | `mem0ai@3.3.1`，`mem0ai/oss`，内嵌 Agent Node 进程                  | 显式写入、检索、更新、删除的技术能力              |
| 业务 Memory Manager | 自研 TypeScript，尚未实现                                           | 权限、候选/确认状态、版本、禁用删除及同步治理     |
| 嵌入                | OpenAI 官方 `text-embedding-3-small`，1536 维                       | 发送文本生成向量，需要 `OPENAI_API_KEY`，产生费用 |
| PostgreSQL          | PostgreSQL 16 + pgvector，镜像摘要锁定在 `infra/docker-compose.yml` | 同实例的独立业务库和记忆库；共享持久卷            |
| SQLite              | Mem0 历史，`better-sqlite3@12.10.0`                                 | SDK ADD/UPDATE/DELETE 历史；不替代业务审计        |

不部署 Mem0 HTTP 服务，不使用 Mem0 Cloud。默认业务库 `agent_ops`、业务运行角色 `agent_ops`；记忆库 `multi_agent_memory`、运行角色 `agent_memory`；初始化管理身份 `agent_ops_admin`。运行角色均非超级用户，各库撤销 PUBLIC CONNECT，互相不得连接。管理身份仅用于显式初始化、扩展与运维，不进入 Agent 配置。

## 首次配置

```sh
npm ci
npm run env:setup
npm run memory:setup
npm run memory:check
```

`env:setup` 生成不覆盖已有文件的私有 `.env`，启动共享 PostgreSQL，创建独立业务角色和数据库。`memory:setup` 创建私有 `.env.memory`、随机记忆密码，并在同一 PostgreSQL 服务中创建记忆数据库、非超级用户和 `vector` 扩展；此步骤不调用外部 API。

在 `.env` 或进程环境中设置 `OPENAI_API_KEY` 和已有 `DEEPSEEK_API_KEY`。不使用 `VITE_*` 保存服务端凭据。`.env.memory` 不包含 OpenAI Key；进程环境优先于文件。普通启动、检查和 CI 不发起嵌入、模型或搜索调用。

```sh
npm run memory:verify
# 仅在本地测试环境/维护窗口，明确接受共享实例短暂中断时：
CONFIRM_SHARED_DB_RECREATE=1 npm run memory:verify -- --recreate-db
```

容器重建会同时中断业务库和记忆库，因此脚本要求上述显式开关；不会删除持久卷。`memory:up` 使用同一个 Compose 服务，`memory:down` 会拒绝执行并提示使用影响明确的 `db:down`。已移除创建第二实例的 `infra/memory-compose.yml`。

## 嵌入和模型调用

`agent/src/memory-config.ts` 固定官方 OpenAI 地址、模型及 1536 维；环境中的自定义 OpenAI 网关不覆盖此地址。旧 Ollama 变量、旧独立端口、不同模型/维度拒绝启动，配置失败不静默降级。

初始化先调用官方嵌入接口，确认向量维度、有限数值及非零内容，再检查记忆库已经启用 `vector`。`mem0_embedding_profiles_v2` 记录集合、模型、维度和配置指纹；这不是供应商底层模型权重摘要，也不保证模型别名永远不变。已有无新配置记录的向量表拒绝直接接管，避免混写旧模型向量。

默认新集合 `mem0_ops_openai_small_v1`。写入与查询使用同一模型、维度和预处理配置。未来修改模型时必须使用新集合、重新嵌入、验证后切换，不能仅更改向量列维度。

Agent 推理仍通过 Claude Agent SDK 调用 DeepSeek。Mem0 构造配置仍需 DeepSeek Key；当前验证与示例使用 `infer:false`，不调用 Mem0 的 LLM，也不自动提取或合并记忆，但会调用 OpenAI 生成嵌入。未来 `infer:true` 的 Mem0 原生 DeepSeek Chat Completions 路径尚未验证；如需统一经 Agent SDK 提取，应先生成候选，经业务确认后显式写入。

```ts
const memory = await createProjectMemory();
await memory.add('仅作技术示例的已确认偏好', {
  userId: 'team-example:weibo-example',
  infer: false,
  metadata: { source: 'technical-example' },
});
```

示例 scope 不代替认证授权；业务 Memory Manager 完成前不接入真实业务上下文。

## 已有环境迁移

1. 先备份业务库、旧独立记忆库和 SQLite 历史；记录旧 Compose 项目/卷/端口。不要删除旧卷，不覆盖 `.env` / `.env.memory`，不要同时运行两个服务写同一卷。
2. 现有业务 Compose 仍使用原服务名、项目名和 `postgres_data` 卷。升级前在卷副本上验证锁定的 PostgreSQL 16 + pgvector 镜像兼容性和恢复；确认后在维护窗口切换镜像。脚本不会为启用扩展而删卷。
3. 旧 `.env` 的 `POSTGRES_USER` 可能也是业务超级用户。保留其作为显式管理身份，由管理员创建新的非超级用户业务角色，并迁移已有对象所有权/授权，再更新 `DATABASE_URL`。初始化脚本拒绝接管归属不同的已有数据库，也不会自动降权或重设已有角色密码。确认业务库所有权与新业务角色一致后再执行 setup。
4. 将旧 `.env.memory` 安全备份到 Git 忽略位置，再生成或手动配置新文件：与 `DATABASE_URL` 相同主机端口、不同数据库和角色，移除 `MEM0_POSTGRES_PORT` / `MEM0_OLLAMA_URL`，使用 OpenAI 模型、1536 维及新集合。保留原 SQLite 历史，历史中旧记忆 ID 不等于新索引已同步。
5. 从权威业务记录或经核实的旧记忆正文重新生成 1536 维向量，验证来源、隔离、召回和数量后切换。旧 768 维向量不能转换或混入新集合；本次不提供无审查的一键数据迁移。
6. 运行 `memory:check` 验证实际跨库连接被拒、非超级用户和扩展；完成真实 OpenAI/中文检索与备份恢复验证后再上线。

## 持久化与验收

PostgreSQL 数据在 `multi-agent-ops-dev_postgres_data`；SQLite 默认 `artifacts/memory/history.sqlite`，可用 `MEM0_HISTORY_PATH` 指向受控持久目录。备份和恢复需同时覆盖业务库、记忆库及 SQLite，之后重新核对版本和同步状态。

`memory:verify` 使用合成文本但真实调用 OpenAI，检查 SDK 写入、语义检索、范围隔离、独立 SQL/SQLite、新进程读取；可选重建共享容器后再读取。报告写入 Git 忽略的 `artifacts/memory/`，不覆盖旧证据。未配置账号/额度/网络时失败，不生成假向量或声称接通；单元测试和不付费的数据库检查不能替代真实嵌入和中文召回验收。

Mem0 3.3.1 无公开 `Memory.close()`，验证器继续使用隔离子进程释放连接；关闭遥测并将 SDK 身份文件限制在仓库的受控目录。依赖风险按实际 `npm audit` 处理，不为消除报告强制降级所锁 Mem0。

官方依据：[OpenAI 嵌入接口](https://developers.openai.com/api/reference/typescript/resources/embeddings/methods/create)、[Mem0 Node SDK](https://docs.mem0.ai/open-source/node-quickstart)、[pgvector](https://github.com/pgvector/pgvector)。
