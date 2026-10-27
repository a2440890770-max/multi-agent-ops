# D2 只读搜索验证

沿用项目统一配置：Claude Agent SDK TypeScript `0.3.311`，DeepSeek 官方 Anthropic 兼容地址，默认模型 `deepseek-flash`，凭证仅来自本地 `DEEPSEEK_API_KEY`。

## 命令与边界

```sh
npm run search:verify
npm run search:verify -- --deny-search
```

默认输出独立时间戳报告到 `artifacts/model/`（Git 已忽略）；`--report=/absolute/path/report.json` 可指定报告位置，已存在的文件不覆盖，也不继续发起付费请求。
正向命令必须全部验收通过才退出 0。负向命令预期退出 1；以 `expectedFailureObserved=true` 区分预期拒绝和其它失败原因。

本次验证工具集合仅为 `WebSearch`、`WebFetch` 和 SDK 内部 `StructuredOutput`；`allowedTools` 用于批准已明确开放的工具，并非单独作为工具集合限制。
`PreToolUse` hook 再检查操作：所有非名单工具拒绝；`WebFetch` 只能访问成功搜索实际返回的 HTTPS 官方文档来源，禁止认证 URL、伪装域名、非标准端口或其它主机。
不读取用户全局 Claude 配置、技能、插件或外部 MCP。模型会话在临时目录运行，不保存会话，结束后清理。主模型、审核模型及供应商配置不受搜索验证修改。

搜索问题固定为：从官方文档查询 DeepSeek Anthropic 兼容接口地址及可用模型名称。只发送公开技术问题，不发送任务原文或业务数据。

## 验收链路

1. 记录真实 `WebSearch` 的查询、工具调用 ID 和返回的结构化来源条目。模型文本中的链接不作为搜索证据。
2. 记录 `WebFetch` 的读取与状态。搜索返回的网页内容作为不可信资料处理，不作为指令执行。
3. SDK 返回的结构化结果通过 Zod 校验；失败结果、缺失 `structured_output` 不采用。
4. 要求至少一次搜索成功返回来源；最终引用必须属于本次真实搜索结果。
5. 程序独立请求最终来源，限制重定向主机，要求 HTTP 成功并在页面正文中找到引用。Markdown 反引号与 HTML 标签归一化后比较，不改写引用中的词语。
6. 接口地址和返回的模型名都必须在读取的实际网页中找到；记录 HTTP 状态、引用匹配及页面 SHA-256，不保存整页内容。

正向报告的 `passed=true` 表示上述链路完成；不据此声称所有站点、搜索问题或未来服务状态都可用。
负向模式通过同一 hook 真实拒绝搜索，要求不能以模型记忆或已知网址完成验收。自动测试另覆盖命令/写入拒绝、来源域名策略、未搜索来源、虚假引用和格式归一化。

每次 SDK 运行最多 8 轮、90 秒，使用 0.25 美元 SDK 估算预算参数；源页面独立请求每次最多 15 秒。预算估算不能替代服务商账单。应用层不自动重试；模型可能重试工具，SDK 也可能重试内部请求。

## 失败处理

缺少密钥、工具失败或被拒绝、没有真实来源、最终引用不属于搜索结果、来源不可访问或引用不匹配，均以非零状态退出并保留失败报告。不会切换到中转站或用模拟结果补齐。
首次开发验证暴露出 HTML 与 Markdown 引用格式差异，已补充回归测试；首次失败报告保留，修复后另行真实重测，不改写历史结果。
若搜索供应商不可用，应登记外部依赖故障与排期影响；不能把本地测试样例视作接通证据。

本次不包含 Mem0、向量存储、Langfuse Trace 或微博发布。

## 官方依据

- [DeepSeek 接入 Claude Code 与 Web Search](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/)
- [DeepSeek 搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Claude Agent SDK 工具权限](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
