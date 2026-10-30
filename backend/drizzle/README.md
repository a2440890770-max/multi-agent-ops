# 业务 SQL 迁移

表定义位于 `backend/src/schema.ts`。`0000_d3_initial.sql` 对齐已有 D3 表：`teams`、`members`、`sessions`、`accounts`、`config_versions`、`audit_events`、`idempotency_records`，并保留原型 `tasks` 表。SQL、Drizzle 快照、迁移日志一起提交代码仓库，不提交本地数据或凭据。

迁移负责建立结构和版本管理；D3 已接通管理员初始化、Session 登录与业务接口权限校验，见[认证说明](../../docs/infra/auth.md)。成员管理、配置和其他业务处理仍为占位。`0001_d4_task_metadata.sql` 为 `tasks` 增加 `created_by`、`team_id`、`current_step`、`error_message`，以及两个外键和查询索引；旧任务的新增字段允许为空，不自动推断创建人或团队。任务仍含 `needs_human` 状态，不等于共享契约中的完整任务模型；后续需通过新迁移升级，不能删除旧数据后重建。

## 新环境

在仓库根目录运行：

```sh
npm ci
npm run env:setup
npm run db:migrate
npm run db:status
npm run dev
```

`env:setup` 创建本地 PostgreSQL、业务库和连接配置；迁移只操作 `DATABASE_URL` 明确指定的现有数据库，不负责创建数据库本身。初始迁移创建 8 张表、外键、检查约束、索引和 3 个更新时间触发器，不插入用户、默认口令或示例业务数据。`npm run dev` 不自动执行迁移。

## 已手动建表的环境

先备份目标业务数据库，再运行：

```sh
npm run db:status
npm run db:baseline
npm run db:migrate
```

`db:baseline` 逐项核对已有 8 张表的字段类型、可空性、默认值、主键、外键、唯一及检查约束、索引、触发器和更新时间函数；与版本化的 `0000_baseline.catalog.json` 完全一致后，才登记初始迁移的真实 SQL 哈希和版本时间。该核对文件来自空库执行初始 SQL 后的 PostgreSQL 系统目录，不包含业务数据。缺表或结构不一致时失败，不自动删表、补字段、重设密码或假装已完成。

登记只增加 `drizzle.__drizzle_migrations` 记录，不执行初始建表 SQL，不修改现有业务行。该日志兼容 Drizzle 的迁移记录格式。已登记后重复运行返回已应用；随后 `db:migrate` 只执行尚未应用的新版本。

若仅有部分表，或核对失败，应先比对真实结构与初始 SQL，在副本上验证明确的升级方案；不要清空数据库、使用 `push` 强行同步，或手工跳过核对写入迁移记录。

## 后续结构变更

### 已手动执行 D4 字段 SQL

仅适用于已登记 D3 初始迁移、并已手动执行本次四字段 SQL 的数据库。先备份，再运行：

```sh
npm run db:status
npm run db:adopt
npm run db:migrate
npm run db:status
```

`db:adopt` 只接管下一个待应用版本。它校验现有迁移历史、该版本 SQL 哈希及对应的 `0001_d4_task_metadata.catalog.json`，锁定并核对全部业务表的字段、默认值、约束、索引和触发器。核对文件来自独立临时库执行版本化 SQL 后的系统目录，不从待接管业务库反推。完全一致后仅新增一条迁移记录，不重跑添加字段 SQL，不更新业务数据。任何偏差或缺少核对文件都拒绝登记，事务失败回滚；重复执行返回已应用。

尚未手动改表的环境直接执行 `npm run db:migrate`。不要修改已登记的初始 SQL，也不要用 `IF NOT EXISTS` 掩盖字段或约束差异。该命令不跳过初始基线核对，不为没有登记历史的数据库自动接管。

### 常规开发流程

`0002_d4_create_task.sql` 补齐创建契约需要的 `account_id`、`reference_inputs`、`lifecycle`、`revision` 及约束。旧任务保留原有数据，账号不自动回填；参考资料默认空数组、生命周期默认开放、版本默认 1。`execution_status` 改为可空并移除排队默认值，新建草稿无尝试时为 null；旧状态值不变。迁移不创建平台账号或业务任务。

1. 修改 `backend/src/schema.ts`。
2. 运行 `npm run db:generate -- --name=描述本次变更`。
3. 评审新增 SQL 和快照；涉及旧数据时补充回填或转换语句。
4. 在临时数据库/恢复副本验证，部署时运行 `npm run db:migrate`。

已应用的 SQL 不允许回头编辑；用新的迁移修正。迁移入口检查本地历史前缀与数据库中的哈希和版本，发现已编辑、缺失或来自不同版本的历史即拒绝执行。所有待执行 SQL 和版本记录在同一事务中应用，失败一起回滚；并发执行通过数据库事务锁串行化。操作前应备份；此流程不提供自动降级命令。

Drizzle Kit 快照不记录 PostgreSQL 函数和触发器，因此 `set_updated_at()` 和 `teams`、`members`、`accounts` 的触发器保存在初始 SQL 中。以后修改这些对象需要评审新的自定义 SQL 迁移；不要认为 `db:generate` 会自动检测它们的差异。

迁移禁止指向系统库、已知记忆库或 `MEM0_DATABASE_URL` 指定的库；Mem0 私有表、pgvector 扩展及 SQLite 历史不由本迁移管理。已有实例的管理员/运行角色分离仍应按 `docs/architecture/memory.md` 的迁移步骤单独处理。

## 验证

```sh
npm run db:test
npm run check
```

`db:test` 使用本地 `.env` 的 PostgreSQL 管理身份创建随机命名的独立测试数据库，用完删除；也可显式提供 `MIGRATION_TEST_ADMIN_URL`。不会向业务库写测试数据，也不调用外部 API。测试覆盖空库、已有表接管与数据保留、结构不符拒绝接管、约束和触发器、重复执行、后续增量升级、失败回滚及历史校验。CI 同时验证新业务运行角色可以实际执行迁移。

### D4 执行尝试与模拟执行

`0003_d4_execution_attempts.sql` 增量新增执行尝试、步骤、模拟产出以及任务当前引用/工作代次，并关联任务审计。只新增结构和审计关联，不启动或重置已有任务。按正常 `npm run db:migrate` 应用；不手动修改旧迁移或重复建表。接口和本地模拟模式见 [任务说明](../../docs/infra/tasks.md)。

`0004_d4_clarification_answers.sql` 新增澄清答复记录表，通过任务/尝试复合外键和同问题唯一约束关联答复。应用后支持当前待澄清尝试继续执行，不会自动启动或改写已有任务。
