# GitHub 热榜 API 请求适配

将用户提供的 axios JavaScript 示例适配为项目 TypeScript 模块，使用 Node 原生 `fetch`，不增加 axios 依赖。

## 配置与调用

在本地 `.env` 或服务端环境中设置 `XXAPI_ACCESS_KEY`。模块不主动读取 `.env`，沿用调用方加载环境的方式；不要将密钥放入前端变量、Agent 提示词或提交到仓库。

```ts
import { fetchGithubHot, GithubHotError } from './integrations/xxapi/github-hot.js';

try {
  const snapshot = await fetchGithubHot({ timeoutMs: 15_000 });
  // snapshot.data 对应原 axios 示例的 response.data。
  // 在定义榜单 Schema 前，其类型为 unknown，消费方必须先校验。
  const rawResponse = snapshot.data;
  void rawResponse;
} catch (error) {
  if (error instanceof GithubHotError) {
    // 只记录安全错误码与 HTTP 状态，不打印原始请求、响应或密钥。
    console.error(error.code, error.httpStatus);
  }
}
```

地址固定为 `https://v2.xxapi.cn/api/githubhot`，请求方法为 GET，鉴权头为 `Authorization: Bearer <access_key>`，与[供应商接口文档](https://xxapi.cn/doc/githubhot)和用户示例一致。默认超时 15 秒，支持 `AbortSignal` 取消；单次调用不自动重试，不接受自定义地址，不跟随重定向。

结果包含供应商、请求地址、本地获取时间和未经业务解释的 JSON 数据。`fetchedAt` 不是榜单更新时间或统计区间。

用户说明 `1` 为成功标记，适配器原样保留 `data: 1`；此标记本身不包含仓库列表。公开文档也未给出可用的榜单字段样例，因此当前不猜测成功码、排名、Star 数、榜单周期或 AI 分类。HTTP 200/合法 JSON 不等于已经取得可发布的研究事实。拿到实际榜单数据后，再增加响应 Schema、业务错误解释及 Research 工具接入。

## 范围与验证

本批只有显式调用的只读 HTTP 适配器，尚未注册为 Research 工具，不修改 Supervisor 权限，不接入数据库、页面、任务定时或发布。普通服务启动不会调用接口。

自动测试注入离线 fetch，覆盖成功标记、未知 JSON、配置错误、HTTP/网络错误、非法 JSON、超时和取消；不读取真实密钥，不请求供应商，也不发起付费模型调用。

```sh
npm run build --workspace=shared
npm run test --workspace=agent
npm run typecheck
npm run build
```
