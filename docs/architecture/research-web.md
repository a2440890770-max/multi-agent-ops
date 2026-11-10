# Research 受限搜索、读取与来源登记

`createResearchWebController()` 接入原生 SDK WebSearch / WebFetch 的前后置 hooks，提供范围校验、调用额度、独立原文核验和本地来源快照。Supervisor 只分派 Research，不直接使用网页工具。创建 controller 本身不联网；当前没有接通数据库任务执行器、页面或真实模型联调。

## 接入

每次研究授权创建独立 controller，并显式传入 Research 接入工厂：

```ts
const webTools = createResearchWebController({
  config: readResearchWebConfig(preparedEnvironment),
  officialSites: [
    {
      origin: 'https://docs.example.com',
      pathPrefix: '/project',
      approvedBy: 'configuration',
      approvalRef: 'account-config-version-1',
    },
  ],
});

const research = createResearchIntegration({
  tools: ['WebSearch', 'WebFetch'],
  maxTurns: researchLimits.maxTurns,
  webTools,
  claimAuthorization: adapters.claimAuthorization,
  authorizeTool: adapters.authorizeTool,
  acceptResult: adapters.acceptResult,
});
```

示例中的环境、配置版本与适配器由真实宿主提供。controller 首次绑定已校验的 ResearchContext，不能跨任务、执行尝试或授权复用。宿主仍负责原子消耗授权、检查本次补查范围和预算、加载必需 Skill、解析及有限纠正报告格式。旧的低层适配器不会自动获得此限制层，必须显式配置 `webTools`。

结果适配器通过 `webTools.getRecords()` 取得真实 sources、materials 和网页 toolAttempts，结合模型报告、媒体登记及执行元数据组装结果。工厂先执行共享业务校验，再校验网页来源、材料内容和调用记录与登记完全一致。不能把模型自述转换成真实工具记录。媒体材料仍由对应受控媒体服务核验。`resolveSource(sourceId)` 可供媒体工具查询当前范围内的真实链接，不向模型开放本地路径或 Cookie。

## 范围

- 官方资料直接开放当前 GitHub 仓库及同仓库 raw 内容。其他官网、文档的 origin 和路径前缀须由后端配置或真实用户确认；授权元数据不能由资料正文提供。
- 第三方搜索仅开放 B 站、小红书、抖音及其已列明的分享域名。查询须包含当前项目名称或 owner/repo，并声明允许域名或 site 条件；返回结果再次校验范围，每次最多交付 10 条。
- WebFetch 只能读取已登记且在范围内的链接：当前项目、用户本轮提供、真实搜索结果及相关文档链接。普通外链只登记线索，不获得官方身份或新站点权限；历史报告里的线索也不自动授权。
- 仅 HTTPS，无 URL 凭据、IP、非标准端口、伪装路径。读取前检查公共 DNS 地址。范围或额度拒绝记为 denied，不执行 SDK 工具、不消耗调用次数；宿主身份或授权校验失败仍停止会话。

项目名称匹配只是机械范围检查，不能证明资料确实相关；Research 仍须判断语义关联和证据质量。网页中要求忽略规则、扩大权限或直接发布的内容始终是外部资料。

## 调用、失败与超时

每轮默认 12 次 WebSearch、10 次 WebFetch，取配置与 ResearchContext 对应限制的较小值。已准入并开始的调用无结果或失败也计次；独立原文核验与对应 WebFetch 合并为一次读取操作。调用 ID、任务/尝试/步骤标识和授权写入登记。

应用层不自动重试。失败后 Research 可在同一轮授权及剩余额度内决定是否再次调用；新调用独立计次，重新获得默认 60 秒时限。不会自动开启新研究轮次。一次网页调用的时限覆盖 SDK 部分及独立原文核验；取消、主会话或 SDK 更早停止时以较早时限为准。

SDK 没有公开的单个原生工具取消接口，应用层网页超时会中止当前 SDK 会话，返回 `RESEARCH_WEB_TIMEOUT`，不能在这个已停止的会话里继续重试，也不自动重启 query。取消后迟到内容不再登记为有效材料。正常完成前等待快照写入；持久化失败不能交付成功。

工具调用记录不代表底层 HTTP 请求次数。原生 SDK 的内部网络重试、缓存和中间跳转不可由 hooks 完整观察或控制，登记明确写入 `sdkNetworkAttempts: 'unobserved'`。SDK 请求 URL 在执行前校验，SDK 报告的最终 URL 在返回后校验；这不保证 SDK 内部每一次跳转都已经由应用审核。下面的独立读取链路则逐跳校验并固定已检查的公共 IPv4 地址。

## 原文与证据

WebSearch 的结构化命中生成后端 sourceId；摘要生成 search_snippet materialId，只作线索。SDK WebFetch 的处理结果单独登记为 sdk_processed，共享证据校验拒绝把它作为原文引用。

随后后端独立请求同一已授权链接，不使用浏览器、Cookie、登录、代理凭据或脚本执行；支持 UTF-8 HTML、纯文本、Markdown。逐跳检查范围及公共 DNS，默认最多 5 次跳转。HTML 通过 parse5 提取正文，排除脚本、隐藏节点和导航等内容。JS 页面、登录限制、非文本或不支持编码可能无法读取，必须如实记录限制。

解压后响应上限默认 10 MiB。超限、响应不完整、网络错误均使本次独立读取失败，不交付半截响应作为原文。SDK 处理结果仍可作为线索保留，并返回原文核验失败警告。

完整响应成功取得后，正文每个材料版本最多保存 50,000 个 UTF-16 字符。截断明确标记，只能引用实际保存部分。返回 nextOffset 后可在本轮剩余额度内再次调用 WebFetch，独立读取的 offset 指提取器生成文本的位置，未必等同于 SDK 内部文本位置。每次正文独立分配材料 ID、版本、内容 SHA-256、解压响应 SHA-256、最终 URL、跳转链和获取时间。证据 startOffset/endOffset 定位本次 material.content，摘录必须精确匹配。

## 配置及存储

| 环境变量                         | 默认值             |
| -------------------------------- | ------------------ |
| RESEARCH_WEB_ROOT                | artifacts/research |
| RESEARCH_WEB_MAX_SEARCH_CALLS    | 12                 |
| RESEARCH_WEB_MAX_FETCH_CALLS     | 10                 |
| RESEARCH_WEB_MAX_SEARCH_RESULTS  | 10                 |
| RESEARCH_WEB_TIMEOUT_MS          | 60000              |
| RESEARCH_WEB_MAX_RESPONSE_BYTES  | 10485760           |
| RESEARCH_WEB_MAX_TEXT_CHARACTERS | 50000              |
| RESEARCH_WEB_MAX_REDIRECTS       | 5                  |

`.env.example` 提供配置项，不修改用户实际 `.env`。controller 不自动加载环境文件。快照保存在 root 下按任务及尝试/授权哈希隔离的随机子目录 `registry.json`；目录 0700，文件 0600，原子替换、串行写入，暂不自动清理。快照会包含正文和完整分享链接，供后端审计使用，不应整体发送模型或日志。该目录已加入 gitignore，数据库持久化与页面展示另行接入。

## 本地验证

`agent/src/research-web.test.ts` 使用固定网页及本地 HTTP fixture 验证域名权限、额度、Agent 再次调用、独立超时、解压体积限制、跳转/DNS 检查、截断分页、原文与摘要隔离、伪造登记拒绝。`agent/src/supervisor.test.ts` 验证原生 hooks 接入、失败后再次调用、三平台搜索记录、注入资料和超时停止会话。测试不发送付费模型请求，不代表三个平台已完成真实联网联调。
