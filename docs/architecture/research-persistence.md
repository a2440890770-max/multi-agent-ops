# D9 Research 数据结构

2026-11-09：用户明确授权实际迁移后，`0014_d9_research_persistence` 已成功应用到本机业务库 `agent_ops`。五张新表、现有表字段及约束已实际创建，迁移状态 `applied=15, pending=0`。应用记录见[迁移核对记录](../acceptance/d9-research-migration-2026-11-09.md)。**尚未运行测试、类型检查、构建或模型调用**，不代表真实执行器、授权接口、数据库登记适配器或页面业务已经接通。

2026-11-09 继续静态复核：补齐 `GithubHotList`、`SelectedProject` 的共享类型导出，并让人工编辑入口复用统一的活跃 attempt 判断，覆盖新增等待状态。验证限制保持不变。

## 新表

| 表                        | 身份及唯一性                                                                                    | 内容与归属                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_hot_snapshots`    | UUID 主键；`(task_id, attempt_id)` 唯一                                                         | `provider=xxapi`；`snapshot` 保存 `{ list: GithubHotList, rawResponse, parserVersion }`；采集时间与列表时间一致。复合外键绑定原 task/attempt。快照不可更新或删除；已选题任务不再插入新榜单。                                              |
| `project_selections`      | UUID 主键；`task_id` 唯一                                                                       | 原始 attempt、原榜单、候选 ID、完整 `SelectedProject`、选题人和时间。创建选择时要求榜单与原 attempt 一致，并核对候选名称和仓库地址；选题后不可更新或删除。                                                                                |
| `research_authorizations` | UUID 主键；每个 attempt 最多一份 initial 授权和一份尚未消耗的授权；消耗步骤唯一                 | 同 task/attempt、选题、`initial/supplement`、不可变 `scope` JSONB、授权人/时间、消耗人步骤/时间。supplement 通过 `base_result_id` 关联本 attempt 最新报告。初始插入必须未消耗，仅允许原子变更为已消耗一次；不能恢复或改写授权。           |
| `research_registries`     | UUID 主键；每个授权一份登记快照                                                                 | task/attempt/authorization、实际研究步骤及输入快照。`snapshot` 首版直接使用现有 `ResearchWebSnapshot`，包含来源、材料版本、网页调用和策略；媒体文件及其处理元数据另存 `research_assets`，研究结果的完整来源/材料/工具交接仍在报告输出中。 |
| `research_assets`         | 不透明文本主键，兼容工具现有 `video_`、`audio_`、`transcript_`、`frame_` ID；`storage_key` 唯一 | task/attempt/authorization、`source_id`、种类、父资产、相对存储键、SHA-256、元数据及时间。父资产需属同 attempt/授权/来源；视频为根，音频和帧来源于视频，转写来源于音频。记录不可更新或删除。文件保留在本地。                              |

后续 attempt 通过授权的 `(task_id, selection_id)` 外键引用原选题，不要求新 attempt 与选题的原始 attempt 相同，也不复制或改写原榜单/选择记录。该结构落实“重新执行不抓榜、不改选”的已确认规则。

新表记录只允许写入当前、开放、未取消的真实 Agent attempt。选题和授权登记校验操作人仍为同团队的 active 成员；这不能替代 HTTP Session、权限及真实用户操作校验。

## 现有执行表

`execution_attempts` 保留所有旧模拟数据，新增允许 `executor_mode=agent`：mock 的 `simulation_scenario` 仍必须为已有三种值之一；agent 必须为空。真实配置快照采用 `{ executorVersion: 1, mode: 'agent', configuration: {...} }`，保存配置而非研究数据。身份和配置快照不可改写。真实配置和模型/工具超时的具体数值仍待确认，本次没有启用后端的 agent 执行模式。

`execution_steps` 新增可空字段，旧历史保持为空：

- `parent_step_id`、`authorization_id`：同 attempt 的父步骤与授权；父步骤 ordinal 必须更小。一份研究授权只绑定一条 Research 步骤，Supervisor 可以关联同份授权。
- `input_snapshot_id`、`frozen_input`：成对保存，输入中的执行标识与本步骤一致；一旦填入不可覆盖。快照 ID 可沿同一主会话传给子 Agent，因此不设全局唯一；关联依靠 `(attempt_id, step_id, input_snapshot_id)`。
- `validated_output`：Supervisor 决定或 Research 完整 `ResearchAcceptedResult`。有输出时步骤必须 completed 且有冻结输入。
- `runtime_metadata`：宿主登记的运行元数据，不采集模型内部推理，不保存凭据。
- `result_id`、`result_version`、`parent_result_id`：从 Research 输出投影，便于唯一约束和外键。报告 ID、版本在 attempt 内唯一，父版本最多一个后继；initial 为第 1 版，supplement 必须延续本次授权指定的报告。历史终态步骤不可改写或删除。

步骤 ordinal 由 `0..3` 放宽为非负整数，支持多次协调及授权补查。完整报告仍保存在步骤 JSONB，不按 claim、gap 或 evidence 新建表。

`task_execution_calls` 新增可空的 `tool_name`、`sdk_session_id`、`sdk_tool_use_id`、`parent_call_id`、`input_snapshot_id`、`authorization_id`。SDK 工具 ID 在同 attempt/会话内唯一；父调用须已存在并属于同 task/attempt；输入和授权外键绑定实际步骤。SDK 追踪字段可在 running 期间由空补齐一次，终态及已有身份字段仍不可改写。

**原有同一步骤最多一条 running call 的唯一索引保持不变。** 本批不确定义原生 SDK 父会话、子 Agent 和工具的并发/逐请求记账模型，不增加免费或重复收费记录，不把新增追踪字段视为已支持任意嵌套并发。

## 状态

| Supervisor 决定       | task/attempt 状态        | 行为                                                 |
| --------------------- | ------------------------ | ---------------------------------------------------- |
| `awaiting_selection`  | `awaiting_selection`     | 等待选题，保留 attempt。                             |
| `needs_clarification` | `awaiting_clarification` | 保留现有状态，真实 Agent 后续重新判断答复语义。      |
| `needs_materials`     | `awaiting_materials`     | 等待用户资料或明确授权的补查，保留 attempt。         |
| `ready_for_content`   | `awaiting_content`       | 待创作，保留同一 attempt；不代表审核通过或允许发布。 |

新等待状态属于“尚未结束”，纳入 task 活跃 attempt 唯一索引和操作锁；不进入 queued/running 调度索引。真实 Agent 等待时要求无租约、`active_since=null`、`next_run_at=null`、`finished_at=null`；累计时间保留。旧 mock 状态和模拟产出流程继续兼容。

研究执行失败结束 attempt，人工重新执行创建新 attempt、重新授权；新 attempt 的报告链从第 1 版开始。工具单次失败或合法 partial 报告不等同于研究执行失败。实际状态转换和调度仍需真实执行器实现，本批不自动更新任何现有任务。

## 写入顺序与后续接线

真实适配器应先锁定 task 和 attempt，并核对当前代次、租约领取 token、取消意图及预算，再进行写入。迁移的 live guard 只提供当前 task/attempt、状态和租约时效的数据库护栏，不能证明调用方持有正确 token。

研究先建立不可变授权及冻结输入步骤，运行时原子消耗授权，再登记网页快照和成功媒体资产。提交结果时先保存本轮最后的 registry，再在同一事务内保存校验后的报告并终结研究步骤。步骤终结或 attempt 失效后，不再允许修改该轮登记或新增资产；不能先终结步骤再补写登记。

JSONB 内部的 question/claim/evidence/material/source、URL 范围、资料性质、实际摘录、媒体哈希和授权 scope 的语义，仍须由共享 Schema、业务校验和真实登记适配器核对。普通外键只覆盖数据库身份归属，不能证明模型结论或磁盘文件真实。

本机应用前已确认没有旧执行器或活动尝试，并保存业务库备份。其他环境应用前仍须停止旧执行器，评审并按用户确认的范围验证。`0000..0014` 已应用版本均不可回改，后续变更新增迁移；Drizzle 快照不包含自定义函数和触发器，未来重新生成时不能丢掉 SQL 中的保护逻辑。
