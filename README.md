# Multi-Agent Ops

内部团队的多 Agent 智能运营项目。第一阶段面向微博单账号纯文案场景。

本仓库使用 **npm workspaces**，由根目录 `package.json` 统一管理 `frontend/`、`backend/`、`agent/`、`shared/`；依赖版本锁定在 `package-lock.json`。

当前交付包括 **D1 工程骨架、接口契约与页面设计，以及 D2 技术验证入口**：保留可导航的 React 页面、53 个业务接口契约与共享类型；整合模型结构化输出、只读搜索及内嵌 Mem0 存储检索的独立验证命令。真实登录、任务执行、业务记忆治理、审批与发布尚未实现，Agent 的 `canExecuteTasks` 继续为 `false`。

接口和页面交付见 [D1 设计索引](docs/design/README.md)。启动后访问 `/tasks` 预览页面，访问 `/api/v1/openapi.json` 读取契约；业务路由校验请求结构后返回 `501 NOT_IMPLEMENTED`，页面明确标注示例数据。`/` 保留真实连接检测。

最终七项技术基线见[技术选型](docs/architecture/stack-decisions.md)：Session / ops_session / 8 小时、DeepSeek + Claude Agent SDK、WebSearch/WebFetch、Drizzle + pg + SQL 迁移、进程内 Mem0 OSS、OpenAI 1536 维嵌入、同实例独立记忆库。登录与业务 Memory Manager 尚未实现。

D2 尚未全部完成；Langfuse 按项目安排延后至主要业务流程完成后接入，微博能力仍待核查。当前技术验证记录及边界见 [D2 状态记录](docs/architecture/d2-status.md)。原始整合记录见 [2026-10-27 整合记录](docs/architecture/local-integration-2026-10-27.md)，本次选型修订见 [2026-10-28 统一记录](docs/architecture/selection-alignment-2026-10-28.md)。

## 环境前提

- Git、Node.js **24.14.0**（可用 `nvm install && nvm use`）。
- npm **11.9.0**（团队基准版本）；先用 `npm --version` 检查。需要调整时运行 `npm install -g npm@11.9.0`。不需要安装其他包管理器。
- 已安装并启动 Docker Engine + Compose v2。macOS/Windows 可使用 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
- 本地端口 5173、3001、3002、5432 可用。GitHub 私有仓库还需本机具有仓库读取权限。

## 克隆后，三步启动

先克隆并进入仓库：

```sh
git clone https://github.com/a2440890770-max/multi-agent-ops.git
cd multi-agent-ops
```

1. 安装依赖：

   ```sh
   npm install
   ```

2. 生成本地配置并启动 PostgreSQL：

   ```sh
   npm run env:setup
   ```

   自动创建 `.env` 和随机本地数据库密码，启动数据库并等待健康检查。重复执行不覆盖已有 `.env`。不会写入业务表，不会创建 Langfuse 或调用真实模型。

3. 启动三部分：

   ```sh
   npm run dev
   ```

打开 **http://127.0.0.1:5173**。页面应显示后端、Agent 空壳、数据库均“已连接”。在终端按 Ctrl+C 停止开发服务；数据库独立运行，可用 `npm run db:down` 停止，持久卷保留。

**只看空壳：** `npm install && npm run dev` 可以不经 setup 启动界面与两个服务入口；数据库会如实显示“待配置”或“未连接”。这不等于数据库环境验收通过。

## 目录与职责

```text
frontend/       React + Vite；业务页面预览与服务状态展示
backend/        Fastify；OpenAPI 契约、业务占位与数据库就绪检查
agent/          Agent 健康检查、模型/搜索验证和内嵌 Mem0 组件
shared/         三部分共享的接口契约
infra/          实际 Docker Compose 配置
docs/           需求、工程说明与协作记录
docs/infra/     环境与故障排查说明
scripts/        初始化、数据库管理与读写检查
tests/e2e/      真实前后端联调的浏览器冒烟测试
.github/        CI、Issue 模板和 PR 模板
```

共享包先构建再启动；`npm run dev` 自动处理，并通过 concurrently 同时启动各部分，一个进程退出时会结束其余进程。Mem0 在 Agent 内按需初始化，普通服务启动不会访问记忆模型或数据库；Temporal 和真实发布服务尚未接入。Langfuse 使用官方 Cloud，后续加入接入代码。

## 常用命令

| 命令                                      | 用途                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `npm run dev`                             | 启动共享契约监听、前端、后端和 Agent 空壳                |
| `npm run check`                           | 契约漂移、格式、Lint、类型、后端/Agent 测试和所有包构建  |
| `npm run contract:generate`               | 从共享定义生成请求/响应类型及逐项接口参考                |
| `npm run format`                          | 统一格式                                                 |
| `npm run env:setup`                       | 首次生成本地环境并启动数据库                             |
| `npm run db:up` / `npm run db:down`       | 启停数据库，不删除持久卷                                 |
| `npm run db:check`                        | 检查数据库连接和临时表读写                               |
| `npm exec -- playwright install chromium` | 安装本机浏览器测试依赖                                   |
| `npm run test:e2e`                        | 启动并验证真实前后端及 Agent 空壳；CI 额外要求数据库就绪 |

后端入口：`GET /api/health`（存活）、`GET /api/ready`（数据库就绪，失败为 503）、`GET /api/agent-health`（Agent 探测）。Agent 入口：`GET /health`。开发服务默认仅监听本机，不是生产部署方案。

## DeepSeek 官方模型接入与验证

项目统一使用 **Claude Agent SDK（TypeScript）→ DeepSeek 官方 Anthropic 兼容接口**，固定地址为 `https://api.deepseek.com/anthropic`，主模型和审核模型默认均为 `deepseek-flash`。只读取 `DEEPSEEK_API_KEY`，不复用中转站、OpenAI 或 Anthropic 账号凭证。

在进程环境或根目录的本地 `.env` 中配置 `.env.example` 所列的 `DEEPSEEK_*` 变量后，运行：

```sh
npm run model:verify
```

该命令会真实调用模型并计费，通过 SDK `outputFormat` 请求结构化结果，检查 SDK 终态和 `structured_output`，再执行 Zod 类型及随机值校验。失败返回非零退出码，不用普通 JSON 文本代替成功。默认在被 Git 忽略的 `artifacts/model/` 中保存脱敏报告。

`npm run dev`、`npm run check` 和 CI 不会自动调用模型，未配置密钥时仍可启动 D1 骨架。详细配置、版本和兼容限制见 [D2 模型接入记录](docs/architecture/deepseek-model.md)。

## D2 只读搜索验证

```sh
npm run search:verify
```

该命令真实调用 DeepSeek 官方接入下的 SDK `WebSearch` / `WebFetch`，返回结构化答案，并独立访问来源核对支持文本、接口地址和模型名。搜索工具必须实际成功返回来源，模型自行生成链接不能通过验收。
只开放这两个读取工具与 SDK 的 `StructuredOutput`；网页读取进一步限制为本次搜索返回的 DeepSeek 官方文档域名。此入口不执行命令、读取本地业务文件或写入业务内容。
默认脱敏报告同样位于 `artifacts/model/`。可通过 `--report` 指定绝对路径。

负向测试命令：

```sh
npm run search:verify -- --deny-search
```

负向测试预期退出码为 1、`passed=false`、`expectedFailureObserved=true`，证明搜索被禁止后没有以模型记忆或伪造来源冒充成功。详情见 [搜索验证说明](docs/architecture/search-verification.md)。两种命令都会进行真实模型请求，搜索调用另按服务商规则计费；普通 CI 不运行。

## D2 内嵌 Mem0 验证

采用 `mem0ai/oss` TypeScript SDK，直接在 Agent 进程运行。PostgreSQL + pgvector 保存记忆正文、向量与元数据；SDK SQLite 保存记忆变更历史。这里没有单独的 Mem0 HTTP 服务或 Mem0 Cloud 账号。

先运行 `npm run env:setup` 启动共享 PostgreSQL，再执行：

```sh
npm run memory:setup
npm run memory:check
# 在 .env 或进程环境配置 OPENAI_API_KEY、DEEPSEEK_API_KEY 后：
npm run memory:verify
```

`memory:setup` 生成私有 `.env.memory`，在业务 PostgreSQL 同实例中创建独立记忆数据库和非超级用户角色，启用 pgvector；不创建第二个 PostgreSQL 容器。业务、记忆运行身份互相无连接权限，不使用管理身份。默认共用 `multi-agent-ops-dev_postgres_data` 持久卷，SQLite 历史另行持久化备份。

嵌入固定为 OpenAI 官方 `text-embedding-3-small` / 1536 维；`infer:false` 跳过 Mem0 自动提取，但仍会调用 OpenAI 并计费。旧 Ollama 768 维、独立实例的验证记录仅是历史证据，新方案的真实账号、中文检索和备份恢复需重新验证。

旧环境切换前备份并阅读[迁移说明](docs/architecture/memory.md)，不要删除原卷或覆盖私有配置。重建共享容器会影响业务库，只有明确确认维护窗口时才运行 `CONFIRM_SHARED_DB_RECREATE=1 npm run memory:verify -- --recreate-db`。普通检查与 CI 不调用外部 API。

业务 ORM 入口为 Drizzle + pg，使用 `npm run db:generate` 生成 SQL 并评审，再用 `npm run db:migrate` 应用；当前没有业务表，Mem0 私有表不由 Drizzle 管理。

## 已有本地目录切换方式

首次切换到本版本时，在更新代码并停止旧开发进程后运行 `npm ci`，再运行 `npm run dev`。如果本地子目录遗留旧安装生成的 `node_modules`，先移走这些依赖目录，再重新 `npm ci`；保留 `.env` 和数据库卷，不删除业务数据。

日常添加依赖后提交根目录 `package-lock.json`。全新克隆可使用 `npm install`，复现锁定环境及 CI 使用 `npm ci`。例如，只向前端添加依赖时使用 `npm install 包名 --workspace=frontend`，单独构建共享包使用 `npm run build --workspace=shared`。

## 两人协作与 CI

每个 Issue 写明需求编号、阶段、完成条件和依赖。使用分支提交 PR，由另一位成员检查后合并；不要提交 `.env`、真实密钥、账号令牌和敏感任务原文。

CI 的两个必需检查名为 **`checks`** 和 **`smoke`**：前者完成格式、Lint、类型、测试与构建；后者按三步流程启动真实 PostgreSQL，验证容器重建后的持久卷、运行浏览器联调测试。详情见 [分支保护说明](docs/github-collaboration.md)。

需求基线见 [PRD V1.0](docs/product/PRD-V1.0.md)，环境说明见 [开发环境](docs/infra/README.md)。
