# D1 工程边界

- `frontend/` 只通过开发代理调用后端，不持有数据库或模型凭据。
- `backend/` 提供 API；存活检查与数据库就绪检查分离，不把缺少数据库描述为全部正常。
- `agent/` 暂时只提供独立启动入口和健康信息，`canExecuteTasks` 固定为 `false`。HTTP 入口仅用于 D1 验证独立进程，不预设后续必须将 Agent 部署为独立网络服务。
- `shared/` 仅保存共享契约，由构建和开发命令先生成产物；不存业务实现和密钥。
- `infra/` 保存真正的容器配置；`docs/infra/` 保存说明。
- Langfuse 使用 Cloud；D1 不启动本地 Langfuse，也不使用真实 API 密钥。

下一项开发是在上述入口上增加任务、执行尝试和内容版本，再实现创建任务与模拟执行链路。后续需要的权限、发布防重、审批失效、三轮修改等约束以 PRD 为准，不能因 D1 空壳健康就视为实现。

## npm 工作区

D2 增加了统一的 DeepSeek 官方模型配置及 SDK 结构化输出调用模块；当前入口为 `npm run model:verify`，配置与兼容边界见 [模型接入记录](deepseek-model.md)。该模块尚未接入任务执行器，健康信息中的 `canExecuteTasks` 继续保持 `false`。主模型与审核模型通过同一配置模块选择，不加载用户全局 Claude 设置或中转站认证。

D2 另在 Agent 中加入按需初始化的 Mem0 OSS TypeScript SDK，使用 PostgreSQL/pgvector 和本地 Ollama 嵌入模型；SDK 历史存储使用经确认的 SQLite。真实存储与重启验证入口为 `npm run memory:verify`，范围及限制见 [Mem0 接入说明](memory.md)。该技术组件尚未接入业务任务、审批或上下文注入。

根目录 `package.json` 的 `workspaces` 声明四个部分。`shared` 版本为 `0.1.0`，三个应用使用相同的普通版本引用，由 npm 链接到本地工作区；不存在需要手动发布的内部包。构建显式先处理 shared，避免依赖 workspace 列表顺序执行时读到缺失产物。

开发命令通过 concurrently 并行运行四个监听进程；Ctrl+C 或其中一个进程退出时结束整组。CI 使用 `npm ci` 和根目录 `package-lock.json`，不依赖旧的包管理器配置。
