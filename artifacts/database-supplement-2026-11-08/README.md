# 现有七表数据库补全与业务账号配置

依据当前 `backend/src/schema.ts`、`backend/drizzle/0000`—`0013` 和用户提供的表名截图整理，日期为 2026-11-08。未连接或修改用户数据库。截图只能确认表名，不能证明现有列、索引、约束或触发器已经符合初始版本。

## 对比结果

当前版本共 21 张业务表、247 个字段。截图已有 `accounts`、`audit_events`、`config_versions`、`idempotency_records`、`members`、`sessions`、`teams`，按截图缺少以下 14 张表：

| 缺少的表 | 用途 | 最初引入的迁移 |
|---|---|---|
| `tasks` | 任务主体、当前状态及关联 | `0000`，后续增量升级 |
| `execution_attempts` | 每次任务执行与租约 | `0003` |
| `execution_steps` | 执行步骤 | `0003` |
| `task_contents` | 内容版本 | `0003` |
| `clarification_answers` | 澄清答复 | `0004` |
| `task_review_cycles` | 审核轮次 | `0005` |
| `task_review_decisions` | 人工审核裁决 | `0005` |
| `task_version_approvals` | 内容版本批准 | `0005` |
| `task_publication_operations` | 发布操作、冻结快照 | `0007` |
| `task_publication_dispatches` | 每次发布发送及重试 | `0007` |
| `task_publication_verifications` | 发布核实、回填证据 | `0008` |
| `task_publication_send_claims` | 发送调用占用、防重 | `0010` |
| `task_execution_budgets` | 任务累计预算 | `0013` |
| `task_execution_calls` | 逐次调用和消耗 | `0013` |

如果现有七张表仍是 `0000` 的初始结构，还需要补充以下字段及配套约束、外键和索引：

| 已有表 | 需要补的字段 | 类型和默认值 | 对应迁移 |
|---|---|---|---|
| `accounts` | `manual_publish_enabled` | `boolean NOT NULL DEFAULT false` | `0006` |
| `accounts` | `registration_version` | `integer NOT NULL DEFAULT 0` | `0006` |
| `accounts` | `registered_by` | `uuid NULL`，关联 `members.id` | `0006` |
| `accounts` | `registered_at` | `timestamptz NULL` | `0006` |
| `audit_events` | `task_id` | `uuid NULL`，关联 `tasks.id` | `0003` |

其他五张已有基础表没有在 `0001`—`0013` 中新增列；仍须核对初始列、索引、约束及三个更新时间触发器。`config_versions` 还会增加不可变历史触发器。完整升级不只是执行 CREATE TABLE：当前任务引用使用复合外键，发布操作和发送记录包含循环引用及延迟外键，历史记录有保护触发器。

`drizzle.__drizzle_migrations` 是另外维护的迁移记录表，不计入 21 张业务表。Mem0 的独立数据库也不在此次补表范围内。

## 执行顺序

先备份现有业务库，停止后端和执行器，再进行以下步骤。这里按业务数据库名和管理员角色均为 `agent_ops` 编写；如果实际数据库名不同，需要修改 SQL 中的目标库检查和授权语句。

如果 `agent_ops` 建表时报“对模式 public 权限不够”，先在 Navicat 中以 `postgres` 超级用户连接 **agent_ops 数据库**，整份执行 `00_prepare_migration_role.sql`。它先回滚失败事务，再授予 `agent_ops` 在当前库创建 schema、在 `public` 创建表的权限，并将截图中的七张业务表（以及已存在的 `tasks`）所有权交给 `agent_ops`，使后续 `ALTER TABLE` 能够执行。这会调整这些业务对象的所有权，不修改业务行、不接管其他业务表、不赋予 `agent_ops_app` 建表权限。脚本末尾会检查两项 CREATE 权限和已有表的所有者。

1. 连接现有的 **agent_ops 数据库**，整份执行 `01_prepare_legacy_tasks.sql`。它在事务内切换到 `agent_ops` 身份，只补齐初始版本的 `tasks` 表，使七表旧库具备登记八表基线的条件；不重建已有七张表。若已有 `tasks`，跳过此文件，先检查迁移状态。
2. 在项目根目录 `.env` 中同时保存应用与管理员连接，变量名必须不同。两条连接指向同一数据库，分别使用各自角色的密码：

   ```dotenv
   DATABASE_URL=postgresql://agent_ops_app:业务账号密码@数据库地址:5432/agent_ops
   DATABASE_ADMIN_URL=postgresql://agent_ops:管理员密码@数据库地址:5432/agent_ops
   ```

   然后运行基线核对：

   ```powershell
   npm run db:baseline
   ```

   迁移命令优先读取 `DATABASE_ADMIN_URL`，后端只读取 `DATABASE_URL`。未配置管理员连接时，迁移命令兼容沿用 `DATABASE_URL`。密码包含 URL 特殊字符时，需要先做 URL 编码。不要将密码发到聊天或提交到仓库。

   `db:baseline` 会检查八张基础表的列、类型、默认值、主外键、索引、CHECK、触发器及 `set_updated_at()` 函数，符合初始结构后才登记 `0000`。**如果核对失败，停止后续操作，根据具体差异修复；不要手工伪造迁移记录。** 第一步已补的空 `tasks` 可以保留，不必删除。如果基线命令报告已登记，则继续用 `db:status` 检查实际版本。

3. 基线通过后，推荐继续使用项目已有迁移命令：

   ```powershell
   npm run db:migrate
   npm run db:status
   ```

   成功后应为 `applied: 14`、`pending: 0`。此处的 14 是迁移版本数量，业务表总数为 21。

   如果需要在 Navicat 等数据库工具中执行 SQL，可**改为**整份执行 `02_upgrade_0001_to_0013.sql`。它要求当前恰好只登记 `0000`，包含 `0001`—`0013` 的全部原始增量 SQL，并在同一事务中写入与仓库一致的原始哈希和版本时间。因此执行后仍可使用 `db:status`、`db:migrate`。不要对同一个库重复执行 SQL 或同时执行两条升级路径。

4. 使用 `postgres` 超级用户执行 `03_create_app_role.sql`，创建数据库登录角色需要相应的角色管理权限，拥有业务表并不自动具备该权限。新建账号时，先将其中 `app_password` 的占位内容改成至少 16 字符的独立强密码；如果账号已经存在且为普通角色，脚本保留原密码并检查是否有管理员权限、其他角色成员资格或对象所有权。遇到这些情况会停止，避免错误地认为撤销授权就能取消所有者的改表权限。
5. 在数据库工具中执行 `04_verify.sql`，确认 21 张表的字段数量正确、缺失字段查询返回零行、迁移记录为 14 条，并核对 `agent_ops_app` 的有效权限。这个检查覆盖表/字段存在性、迁移记录与授权，完整业务行为还需在测试环境验证。
6. 确认后端实际使用的 `.env` 保留两条连接，`DATABASE_URL` 使用业务账号，`DATABASE_ADMIN_URL` 保留管理员：

   ```dotenv
   DATABASE_URL=postgresql://agent_ops_app:业务账号密码@数据库地址:5432/agent_ops
   DATABASE_ADMIN_URL=postgresql://agent_ops:管理员密码@数据库地址:5432/agent_ops
   ```

   如果此前按旧说明在 PowerShell 设置过临时 `DATABASE_URL` 覆盖，先清除该临时变量后再启动服务，使其读取更新后的 `.env`。重启后端和执行器。以后直接运行原有迁移命令即可使用管理员连接；普通业务账号不运行 DDL 迁移。配置独立管理员连接后，`db:up` 不再按业务账号自动接管数据库所有权，数据库与角色由管理员预先创建并授权。

## 账号与权限说明

新增 `agent_ops_app` 是增加 PostgreSQL 登录角色，继续使用同一个 `agent_ops` 数据库和 `public` 中同一批业务表，不创建另一套业务表，也不向 `accounts` 或 `members` 插入数据库登录账号。`accounts` 存放微博等目标平台账号，`members` 存放网站的成员登录身份。

本补充包按管理员负责迁移、业务角色负责数据读写配置。业务角色获得业务表的 SELECT/INSERT/UPDATE/DELETE 权限，不成为表或数据库所有者，不加入管理员角色，不获得创建数据库、管理角色或修改现有业务表结构的权限。历史表的 UPDATE/DELETE 仍受原有保护触发器限制。

`03` 会撤销 `PUBLIC` 在 `public` schema 上的 CREATE 权限，避免旧版 PostgreSQL 的公共授权让业务账号继续建表。这会影响依赖该公共权限建表的其他普通账号，应确认这些账号不承担迁移职责。管理员拥有对象的权限不因此被撤销。

默认权限使用 `ALTER DEFAULT PRIVILEGES FOR ROLE agent_ops`，只覆盖此后由 `agent_ops` 创建的对象；若使用其他角色建表，需要为该实际创建角色另外设置默认授权。已有表的访问权由本次显式 GRANT 提供。

如果已有 `agent_ops_app` 可以连接数据库，但应用报“对表权限不够”，可由业务表所有者 `agent_ops` 执行 `03b_grant_existing_app_role.sql`，补齐明确列出的 21 张表的读写及后续对象默认授权。该脚本会先核对业务角色权限范围。如果此前误给了该角色 `CREATEDB` 属性，需先由 `postgres` 执行 `ALTER ROLE agent_ops_app NOCREATEDB;`。业务角色的 CONNECT 权限或 `db:check` 的临时表检查通过，不代表已经获得业务表访问权限；应以 `04_verify.sql` 的逐表权限结果为准。

若确实要求业务账号也可以随意修改现有表结构，需要给予对象所有权或可切换到所有者的权限；这会扩大运行账号的权限范围。本包按应用连接与结构升级分开的方式配置。

参考 PostgreSQL 官方文档：[CREATE ROLE](https://www.postgresql.org/docs/current/sql-createrole.html)、[GRANT](https://www.postgresql.org/docs/current/sql-grant.html)、[ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html)、[Schema 权限](https://www.postgresql.org/docs/current/ddl-schemas.html)。

## 生成和核对

SQL 来自当前项目的原始迁移及 `0013_snapshot.json`，没有改写已有迁移文件或 `schema.ts`。迁移入口已支持独立管理员连接。重新生成 SQL 可运行：

```powershell
node artifacts/database-supplement-2026-11-08/build-supplement.mjs
```

生成过程不连接数据库，核对 21 张表、247 个字段、13 份增量迁移正文以及写入的迁移哈希和版本时间。最终还需在恢复副本或测试库验证后再应用到业务库。
