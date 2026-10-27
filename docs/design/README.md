# D1 接口与页面交付

2026-10-27，设计初稿，待共同评审；业务 AC 未验收。

已在本地整合远程 `main` 的 D2 模型、搜索和 Mem0 技术验证入口。D1 页面/契约继续保留；D2 验证组件尚未接入业务工作流。整合来源与检查结果见 [本地整合记录](../architecture/local-integration-2026-10-27.md)。

1. [接口契约说明](api-contract.md)：权限、并发、防重、错误、超时、审计、AC 与关键请求示例。
2. [逐项接口参考](api-reference.md)：由共享操作目录生成，包含方法/路径、请求字段校验、响应、角色、状态和转换。
3. `shared/src/domain.ts`、`api.ts`、`contracts.ts`、`responses.ts`：稳定类型、请求结构、操作目录；响应 Schema 从 TS 自动生成。
4. [页面设计说明](page-design.md)：页面路由、布局草图、字段来源、按钮规则、异常状态与刷新行为；`frontend/src/pages` 为可导航骨架。

输入基线为 [核心对象设计](domain-model.md) 与 [状态转换表](state-transitions.md)，从用户提供的两份本地文档保留入库。PRD 已同步“批准与点击发布分开”及已批准未发布可保存后失效旧批准的规则。

运行 `npm run dev` 后打开 `/tasks` 查看设计；`/` 继续进行真实服务健康检测。`/tasks/task-demo` 支持状态与异常场景预览；所有预览数据和身份切换均不产生业务副作用。`GET /api/v1/openapi.json` 可读取完整机器契约。业务占位接受结构校验后的合法请求返回 501，不能用于实际任务、登录或发布。

`npm run contract:generate` 同步响应 Schema 和逐项参考；`npm run check` 检查生成物、格式、类型、后端测试及构建；`npm run test:e2e` 验证浏览器导航、锁定与冲突展示。设计评审和真实业务验收分别记录，不把占位测试通过等同于 AC-01—AC-14 通过。
