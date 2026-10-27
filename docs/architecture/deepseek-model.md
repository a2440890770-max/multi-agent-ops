# D2 模型接入与结构化输出

决策日期：2026-10-27。项目统一使用 Claude Agent SDK TypeScript 接入 DeepSeek 官方 API，不以此前中转站测试结果替代本配置验证。

## 接入配置

| 项目             | 配置                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 运行时           | Node.js 24.14.0、npm 11.9.0                                            |
| Claude Agent SDK | `0.3.311`，其内置 Claude Code 为 `2.1.311`                             |
| Zod              | `4.6.7`                                                                |
| 官方兼容地址     | `https://api.deepseek.com/anthropic`，在代码中固定，不接受网关地址覆盖 |
| 主模型           | `DEEPSEEK_MODEL`，默认 `deepseek-flash`                                |
| 审核模型         | `DEEPSEEK_REVIEW_MODEL`，默认 `deepseek-flash`                         |
| 凭证             | `DEEPSEEK_API_KEY`，从进程环境或本地 `.env` 读取，不写入代码或报告     |

允许的模型标识为 `deepseek-flash`、`deepseek-v4-pro`；本次默认验收针对 Flash，不宣称 Pro 已通过验证。模型标识为官方别名，不是不可变快照；更改或升级后需重新验证。
依赖的确切版本及间接依赖固定在根目录 `package-lock.json`；复现安装使用 `npm ci`。

统一配置在 `agent/src/model-config.ts`，可复用的结构化调用在 `agent/src/structured-model.ts`。
SDK 子进程仅继承必要的运行时和代理变量，再注入官方地址、当前角色模型与官方凭证；旧网关地址、认证头、其他提供商选择及数据库凭证不传入。
SDK 的默认模型别名和辅助模型也绑定到当前角色选用的 DeepSeek 模型，不提供自动切换到其他供应商的回退。

## 运行

在本地根目录 `.env` 中配置或从 shell 提供 `DEEPSEEK_API_KEY`。不要提交该文件；不要在前端配置 `VITE_*` 模型密钥。

```sh
npm ci
npm run model:verify
```

这会真实调用并产生费用。默认报告位于 `artifacts/model/`（Git 已忽略）。可指定绝对输出路径或验证审核角色：

```sh
npm run model:verify -- --role=review --report=/absolute/path/review-verification.json
```

报告路径不覆盖已有文件。只有显式运行验证命令才调用模型；常规启动、检查和 CI 不需要模型密钥，不产生模型请求。
本配置作用于项目，不修改开发者的 Codex 或 Claude 全局设置。

## 结构化结果准入

1. Zod Schema 转换成 JSON Schema draft-07，作为 SDK 的 `outputFormat` 传入。
2. SDK 最终结果必须为 `subtype=success` 且 `is_error=false`。
3. 必须存在 `structured_output`；不能回退到解析 `result` 中的普通 JSON 字符串。
4. 再由本地 Zod Schema 检查必填字段、类型、枚举、嵌套对象及额外字段。
5. 验证命令额外检查随机校验值、整数计算结果、布尔值和数组内容，避免仅 HTTP 成功就验收。

SDK 通过内部 `StructuredOutput` 工具收集并校验结果。本次不启用文件、命令、搜索、技能或外部 MCP 工具；`StructuredOutput` 是 SDK 的结构化输出机制。
调用最多 4 轮、50 秒，使用 SDK 的 0.1 美元预算参数；此预算为 SDK 估算控制，不作为服务商账单承诺。应用层不自动重试；SDK 内部可能进行请求或格式重试，不能称为只发出一次底层 HTTP 请求。
缺少密钥、网络/认证错误、无结构化结果、Schema 不匹配、轮数/预算或超时失败均不验收通过。失败抛出错误，验证命令以非零状态退出，保留脱敏证据。

## 兼容边界与证据

DeepSeek 官方提供 Anthropic 格式及 Claude Code 接入方案；本项目按第三方兼容方式验证，不表述为 Anthropic 对 DeepSeek 的官方支持。
DeepSeek 兼容表中 `output_config` 仅支持 `effort`；本项目使用并实测的是 SDK `StructuredOutput` 工具机制，不承诺服务端原生严格 JSON Schema 支持。
验证记录以真实命令生成的 JSON 为准；本地单元测试不作为外部接通证据。
本节验证范围为模型配置和 SDK 结构化输出，不包含搜索、Mem0/向量检索、Langfuse、微博发布或完整任务工作流。

- [DeepSeek Anthropic 兼容文档](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)
- [DeepSeek 接入 Claude Code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/)
- [Claude Agent SDK 结构化输出](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
