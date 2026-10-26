# Multi-Agent Ops

内部团队的多 Agent 智能运营项目。第一阶段面向微博单账号纯文案场景。

当前交付为 **D1 工程骨架**：三部分可同时启动、数据库开发环境、服务健康检测和 CI。尚未实现任务创建、模拟任务执行、真实模型调用、记忆、审批与发布。Agent 的 `shell` 状态只代表入口启动，不代表具备执行能力。

## 环境前提

- Git、Node.js **24.14.0**（可用 `nvm install && nvm use`）。
- pnpm **11.24.0**；尚未安装时运行 `npm install -g pnpm@11.24.0`。
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
   pnpm i
   ```

2. 生成本地配置并启动 PostgreSQL：

   ```sh
   pnpm env:setup
   ```

   自动创建 `.env` 和随机本地数据库密码，启动数据库并等待健康检查。重复执行不覆盖已有 `.env`。不会写入业务表，不会创建 Langfuse 或调用真实模型。

3. 启动三部分：

   ```sh
   pnpm dev
   ```

打开 **http://127.0.0.1:5173**。页面应显示后端、Agent 空壳、数据库均“已连接”。在终端按 Ctrl+C 停止开发服务；数据库独立运行，可用 `pnpm db:down` 停止，持久卷保留。

**只看空壳：** `pnpm i && pnpm dev` 可以不经 setup 启动界面与两个服务入口；数据库会如实显示“待配置”或“未连接”。这不等于数据库环境验收通过。

## 目录与职责

```text
frontend/       React + Vite；页面与服务状态展示
backend/        Fastify；API、配置与数据库就绪检查
agent/          独立 Agent 开发入口；D1 仅健康检查
shared/         三部分共享的接口契约
infra/          实际 Docker Compose 配置
docs/           需求、工程说明与协作记录
docs/infra/     环境与故障排查说明
scripts/        初始化、数据库管理与读写检查
tests/e2e/      真实前后端联调的浏览器冒烟测试
.github/        CI、Issue 模板和 PR 模板
```

共享包先构建再启动；`pnpm dev` 自动处理。首期不引入 Temporal、Mem0 或真实发布服务。Langfuse 使用官方 Cloud，后续只加入接入代码。

## 常用命令

| 命令                                    | 用途                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                              | 启动共享契约监听、前端、后端和 Agent 空壳                |
| `pnpm check`                            | 格式、Lint、类型、后端测试和所有包构建                   |
| `pnpm format`                           | 统一格式                                                 |
| `pnpm env:setup`                        | 首次生成本地环境并启动数据库                             |
| `pnpm db:up` / `pnpm db:down`           | 启停数据库，不删除持久卷                                 |
| `pnpm db:check`                         | 检查数据库连接和临时表读写                               |
| `pnpm exec playwright install chromium` | 安装本机浏览器测试依赖                                   |
| `pnpm test:e2e`                         | 启动并验证真实前后端及 Agent 空壳；CI 额外要求数据库就绪 |

后端入口：`GET /api/health`（存活）、`GET /api/ready`（数据库就绪，失败为 503）、`GET /api/agent-health`（Agent 探测）。Agent 入口：`GET /health`。开发服务默认仅监听本机，不是生产部署方案。

## 两人协作与 CI

每个 Issue 写明需求编号、阶段、完成条件和依赖。使用分支提交 PR，由另一位成员检查后合并；不要提交 `.env`、真实密钥、账号令牌和敏感任务原文。

CI 的两个必需检查名为 **`checks`** 和 **`smoke`**：前者完成格式、Lint、类型、测试与构建；后者按三步流程启动真实 PostgreSQL，验证容器重建后的持久卷、运行浏览器联调测试。详情见 [分支保护说明](docs/github-collaboration.md)。

需求基线见 [PRD V1.0](docs/product/PRD-V1.0.md)，环境说明见 [开发环境](docs/infra/README.md)。
