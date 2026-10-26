# GitHub 协作与 main 保护

## 目标设置

- 默认分支 `main`，所有业务改动经 PR。
- 合并需要 **1 名其他成员批准**；新提交使旧批准失效。
- 合并前必需检查：`checks`、`smoke`，并要求分支与基线保持最新。
- 不允许强制推送或删除 main；保留管理员正常管理权限，不设置自动绕过合并。

空仓库需要先有一个最小基线提交，才有 PR 的目标分支。D1 的工程实现应放在功能分支上提交首个 PR，不自动合并。

## 套餐与权限

私有仓库可以免费邀请协作者，但强制分支保护受套餐限制。GitHub 官方说明：公共仓库可在 Free 使用保护，私有仓库需要适用的 Pro/Team/Enterprise 套餐。若 API 返回套餐限制，不能把 CI 文件存在或协作约定当成保护已生效。

参见 [GitHub 官方分支保护说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)。本任务不自动升级套餐或改变仓库可见性。

仓库管理员可以在 Settings → Branches 添加 main 的保护规则。先运行一次 CI，以便识别 `checks`、`smoke`。如暂时无法启用强制保护，仍由两人按 PR + review 的方式协作，强制保护项保留未完成。

## 本次配置结果（2026-10-26）

已实际尝试为本私有仓库设置 `main` 保护，GitHub API 返回 **403**：`Upgrade to GitHub Pro or make this repository public to enable this feature.` 因此 **CI 必过及一人 review 的强制保护尚未生效**，不是已完成事项。管理员应在确认是否升级套餐后再应用上述设置；本次不变更可见性，也不购买服务。
