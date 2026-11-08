import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const root = new URL('../../', import.meta.url);
const output = new URL('./', import.meta.url);
const folder = fileURLToPath(new URL('backend/drizzle/', root));
const migrations = readMigrationFiles({ migrationsFolder: folder });
const journal = JSON.parse(await readFile(new URL('backend/drizzle/meta/_journal.json', root), 'utf8'));
const snapshot = JSON.parse(await readFile(new URL('backend/drizzle/meta/0013_snapshot.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('backend/drizzle/0000_baseline.catalog.json', root), 'utf8'));
assert.equal(migrations.length, 14, '本补充包固定对应 0000—0013；版本变化后需要重新审核。');
assert.equal(migrations[0].hash, manifest.sqlHash);
assert.equal(journal.entries.at(-1).tag, '0013_d9_execution_limits');
const tables = Object.values(snapshot.tables).sort((a, b) => a.name.localeCompare(b.name));
assert.equal(tables.length, 21);
assert.equal(tables.reduce((n, table) => n + Object.keys(table.columns).length, 0), 247);
const legacy = ['accounts', 'audit_events', 'config_versions', 'idempotency_records', 'members', 'sessions', 'teams'];
const taskDDL = migrations[0].sql.find((statement) => /^\s*CREATE TABLE "tasks"\s*\(/.test(statement));
assert.ok(taskDDL);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const targetGuard = `DO $target_guard$
BEGIN
  IF current_database() <> 'agent_ops' THEN
    RAISE EXCEPTION '请连接现有业务数据库 agent_ops 后执行；当前库为 %', current_database();
  END IF;
END;
$target_guard$;`;

const prepare = `-- 仅用于截图中的七张 D3 基础表、缺少 tasks 的旧库。
-- 先备份并停止后端/执行器；缺少权限时先以 postgres 执行 00_prepare_migration_role.sql。
-- 连接 agent_ops 数据库；事务内使用 agent_ops 身份创建，确保表所有权正确。
-- 执行后必须运行 npm run db:baseline，通过核对后再执行 02 或 db:migrate。
-- 不要跳过基线核对；本文件只补初始 tasks，后续迁移将其升级为完整任务表。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
${targetGuard}
SET LOCAL ROLE agent_ops;
SELECT pg_advisory_xact_lock(1835100527, 168101);
DO $legacy_guard$
DECLARE
  table_name text;
  has_history boolean;
BEGIN
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'agent_ops 缺少 public 建表权限；请先以 postgres 执行 00_prepare_migration_role.sql。';
  END IF;
  IF to_regclass('public.tasks') IS NOT NULL THEN
    RAISE EXCEPTION 'tasks 已存在，不适用七表补全脚本；请核对 db:status / db:baseline。';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[${legacy.map(literal).join(', ')}]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || table_name) AND relkind = 'r') THEN
      RAISE EXCEPTION '缺少预期基础表 public.%；请先核对现有结构。', table_name;
    END IF;
  END LOOP;
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)' INTO has_history;
    IF has_history THEN
      RAISE EXCEPTION '已有迁移记录却缺少 tasks，请先核对迁移历史和备份，不能按七表初始库处理。';
    END IF;
  END IF;
END;
$legacy_guard$;
LOCK TABLE ${legacy.map((name) => `public.${name}`).join(', ')} IN SHARE MODE;
${taskDDL.trim()}
COMMIT;
`;

const upgrade = `-- 从已核对并登记的 0000 基线升级至 0013；生成日期 2026-11-08。
-- 前置：先执行 01，再用管理员连接运行 npm run db:baseline 并确认成功。
-- 以下内容直接取自仓库原始迁移，保留约束、索引、函数、触发器和原始迁移哈希。
-- 与 npm run db:migrate 二选一。本文件不适用于中途已经升级过的库，也不重复执行。
-- 请在同一连接整份执行；任何错误后先 ROLLBACK，禁止跳过错误继续提交。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
${targetGuard}
SELECT pg_advisory_xact_lock(1835100527, 168101);
DO $baseline_guard$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '缺少迁移基线，请先运行 npm run db:baseline，禁止直接补写迁移记录。';
  END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 1 OR NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
    WHERE hash = ${literal(migrations[0].hash)} AND created_at = ${migrations[0].folderMillis}
  ) THEN
    RAISE EXCEPTION '要求仅有已核对的 0000 基线；已升级的数据库请用 npm run db:migrate。';
  END IF;
END;
$baseline_guard$;
${migrations.slice(1).map((migration, index) => `
-- ${journal.entries[index + 1].tag}.sql
${migration.sql.map((statement) => statement.trim()).filter(Boolean).join('\n')}
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES (${literal(migration.hash)}, ${migration.folderMillis});
`).join('\n')}
COMMIT;
`;

const roles = `-- 在完成业务表迁移后，使用有创建角色及授权权限的管理员执行。
-- 数据库仍为 agent_ops；新增的是数据库登录角色 agent_ops_app。
-- 对象所有权保留给管理员/迁移身份；业务角色只读写业务数据。
-- 新建角色时必须替换下方密码；已有普通角色会保留原密码。
BEGIN;
SET LOCAL lock_timeout = '5s';
${targetGuard}
DO $app_role$
DECLARE
  app_password text := 'REPLACE_WITH_A_STRONG_PASSWORD';
  app_oid oid;
BEGIN
  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'agent_ops_app';
  IF app_oid IS NULL THEN
    IF app_password = 'REPLACE_WITH_A_STRONG_PASSWORD' OR length(app_password) < 16 THEN
      RAISE EXCEPTION '请先把 app_password 替换为至少 16 字符的独立强密码。';
    END IF;
    EXECUTE format('CREATE ROLE agent_ops_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', app_password);
    SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'agent_ops_app';
  ELSE
    IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = app_oid AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION '已有 agent_ops_app 带管理权限，请先人工核对该角色用途及权限。';
    END IF;
    ALTER ROLE agent_ops_app LOGIN NOINHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = app_oid) THEN
    RAISE EXCEPTION 'agent_ops_app 已加入其他角色，请先核对继承/SET ROLE 权限。';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = app_oid)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = app_oid)
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle') AND c.relowner = app_oid) THEN
    RAISE EXCEPTION 'agent_ops_app 已拥有数据库/schema/业务对象；请先由管理员调整所有权，GRANT/REVOKE 无法取消所有者的改表权限。';
  END IF;
END;
$app_role$;

GRANT CONNECT ON DATABASE agent_ops TO agent_ops_app;
REVOKE CREATE ON DATABASE agent_ops FROM agent_ops_app;
-- PUBLIC 是所有角色的公共授权来源。旧版 PostgreSQL 必须同时撤销该来源。
-- 这一句会影响依赖 PUBLIC CREATE 的其他普通账号，请确认它们不承担迁移职责。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM agent_ops_app;
GRANT USAGE ON SCHEMA public TO agent_ops_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ${tables.map((table) => `public.${table.name}`).join(',\n  ')}
TO agent_ops_app;

-- 当前业务表主键使用 UUID，此项为 public 中可能使用序列的业务对象预留。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent_ops_app;

-- 只对 agent_ops 此后新建的对象生效；实际迁移角色不同时请修改 FOR ROLE。
ALTER DEFAULT PRIVILEGES FOR ROLE agent_ops IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agent_ops IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agent_ops_app;

DO $effective_privileges$
BEGIN
  IF has_schema_privilege('agent_ops_app', 'public', 'CREATE')
     OR has_database_privilege('agent_ops_app', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'agent_ops_app 仍有有效 CREATE 权限，请核对 PUBLIC/其他授权来源；本事务已拒绝提交。';
  END IF;
END;
$effective_privileges$;
COMMIT;
-- 不向业务角色授予 drizzle 迁移记录的写权限，也不授予管理员角色成员资格。
`;

const verify = `-- 只读检查；以管理员执行可以完整查看迁移历史与权限。
SELECT current_database() AS database_name, current_user AS login_role;

-- 预期每行 actual_columns 与 expected_columns 相等，表数共 21，字段合计 247。
WITH expected(table_name, expected_columns) AS (VALUES
${tables.map((table) => `  (${literal(table.name)}, ${Object.keys(table.columns).length})`).join(',\n')}
)
SELECT e.table_name, e.expected_columns, count(c.column_name)::integer AS actual_columns
FROM expected e LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = e.table_name
GROUP BY e.table_name, e.expected_columns ORDER BY e.table_name;

-- 预期返回 0 行；可用于迁移前查看缺失字段（缺表会列出整张表的字段）。
WITH expected(table_name, column_name) AS (VALUES
${tables.flatMap((table) => Object.keys(table.columns).map((column) => `  (${literal(table.name)}, ${literal(column)})`)).join(',\n')}
)
SELECT e.* FROM expected e LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = e.table_name AND c.column_name = e.column_name
WHERE c.column_name IS NULL ORDER BY e.table_name, e.column_name;

-- 原始迁移记录应为 14 条（0000—0013），不计入 21 张 public 业务表。
-- 迁移前若不存在 drizzle.__drizzle_migrations，跳过下一条查询。
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id;

-- 创建角色之后执行：agent_ops_app 行的管理标志全部应为 false。
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname IN ('agent_ops', 'agent_ops_app');
-- 只在 agent_ops_app 已存在后执行下一条。
SELECT has_database_privilege('agent_ops_app', 'agent_ops', 'CONNECT') AS can_connect,
       has_schema_privilege('agent_ops_app', 'public', 'USAGE') AS can_use_schema,
       has_schema_privilege('agent_ops_app', 'public', 'CREATE') AS can_create_in_public,
       has_database_privilege('agent_ops_app', 'agent_ops', 'CREATE') AS can_create_schema;

SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
       has_table_privilege('agent_ops_app', c.oid, 'SELECT') AS can_select,
       has_table_privilege('agent_ops_app', c.oid, 'INSERT') AS can_insert,
       has_table_privilege('agent_ops_app', c.oid, 'UPDATE') AS can_update,
       has_table_privilege('agent_ops_app', c.oid, 'DELETE') AS can_delete
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname;
-- 某些历史表即便具有 UPDATE/DELETE 权限，也会由业务触发器阻止修改或删除。
`;

for (const [name, content] of [
  ['01_prepare_legacy_tasks.sql', prepare],
  ['02_upgrade_0001_to_0013.sql', upgrade],
  ['03_create_app_role.sql', roles],
  ['04_verify.sql', verify],
]) {
  await writeFile(new URL(name, output), content, 'utf8');
}

// Verify every copied migration and its ledger entry; no database is opened.
for (const migration of migrations.slice(1)) {
  for (const statement of migration.sql.filter((statement) => statement.trim())) {
    assert.ok(upgrade.includes(statement.trim()));
  }
  assert.ok(upgrade.includes(`VALUES (${literal(migration.hash)}, ${migration.folderMillis});`));
}
console.log('已生成 4 份 SQL；核对 21 张表、247 个字段、13 份原始增量迁移和全部迁移哈希。未连接数据库。');
