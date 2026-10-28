# 开发环境与故障排查

实际容器配置位于仓库根目录的 `infra/docker-compose.yml`。这里只保存说明，避免维护两份配置。

## 配置与密钥

`.env.example` 只含变量名与说明。`npm run env:setup` 生成仅本机使用的 `.env` 和随机数据库密码，已有文件不会被覆盖；Unix 系统文件权限为 0600。环境变量优先于本地文件。前端仅使用 Vite 默认公开前缀的变量，不将数据库和模型凭据导入浏览器。

普通启动不需要模型、嵌入或 Langfuse 密钥。模型/搜索验证需 DEEPSEEK_API_KEY，记忆真实验证另需 OPENAI_API_KEY。开发数据库仅绑定 `127.0.0.1`，数据保存在 `multi-agent-ops-dev_postgres_data` 持久卷。

## 常见问题

- **找不到 Docker / 无法连接 daemon**：安装并启动 Docker Desktop 或 Docker Engine，确认 `docker compose version`、`docker info` 成功后再运行 `npm run env:setup`。脚本失败不能算数据库已启动。
- **端口冲突**：修改 `.env` 中对应端口。数据库端口变化时同步修改 `DATABASE_URL`；Agent 端口变化时同步修改 `AGENT_BASE_URL`。重新启动开发服务。浏览器测试默认使用 5173/3001/3002，测试时保持这些默认值。
- **数据库显示未连接**：运行 `npm run db:up` 和 `npm run db:check`；确认密码、库名与已有卷一致。
- **修改 POSTGRES_PASSWORD 后认证失败**：数据库镜像初始化变量只对空数据卷生效，已有卷不会自动更新密码。不要为了修复配置直接删卷；先恢复旧配置或在数据库中有计划地修改密码。
- **首次安装较慢**：需下载 npm 包和 PostgreSQL 16 + pgvector 镜像。跨平台由官方镜像选择对应架构。
- **依赖包契约找不到**：`npm run dev` / `npm run check` 会先构建 shared；单独启动包前运行 `npm run build --workspace=shared`。

`npm run db:down` 不带 `-v`，不会删除数据。仓库不提供一键删卷脚本。新环境使用独立的初始化管理身份、业务角色和记忆角色；记忆库与业务库共享实例，数据库及角色分离。运行 `npm run memory:setup` / `npm run memory:check` 检查配置，不会调用外部 API。旧超级用户配置、镜像/卷兼容和旧 768 维索引的迁移见[记忆接入](../architecture/memory.md)。生产部署、备份恢复验收、HTTPS 和服务端 Session 登录仍属于后续工作。
