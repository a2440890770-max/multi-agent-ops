-- 仅用于现有 agent_ops 业务库：以 postgres 超级用户连接后整份执行。
-- 补齐 agent_ops 的迁移权限，并将明确列出的业务表所有权交给 agent_ops。
-- 不向 agent_ops_app 授予建表权限；不修改业务行或迁移历史。
-- 清理上一次建表失败留下的事务；无事务时的提示可以忽略。
ROLLBACK;
RESET ROLE;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $target_guard$
BEGIN
  IF current_database() <> 'agent_ops' THEN
    RAISE EXCEPTION '请连接 agent_ops 数据库；当前数据库为 %', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE EXCEPTION '请使用 PostgreSQL 超级用户执行权限准备脚本；当前身份为 %', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_ops') THEN
    RAISE EXCEPTION '缺少迁移角色 agent_ops，请先核对角色配置。';
  END IF;
END;
$target_guard$;

SELECT pg_advisory_xact_lock(1835100527, 168101);

-- 数据库 CREATE 用于迁移器创建 drizzle schema，不是 CREATEDB 角色属性。
GRANT CONNECT, CREATE ON DATABASE agent_ops TO agent_ops;
GRANT USAGE, CREATE ON SCHEMA public TO agent_ops;

-- 后续 ALTER TABLE 要求对象所有者权限，普通表读写授权不能替代所有权。
-- 仅处理截图中的七张表，不使用 REASSIGN OWNED 接管其他对象。
ALTER TABLE public.accounts OWNER TO agent_ops;
ALTER TABLE public.audit_events OWNER TO agent_ops;
ALTER TABLE public.config_versions OWNER TO agent_ops;
ALTER TABLE public.idempotency_records OWNER TO agent_ops;
ALTER TABLE public.members OWNER TO agent_ops;
ALTER TABLE public.sessions OWNER TO agent_ops;
ALTER TABLE public.teams OWNER TO agent_ops;

DO $existing_objects$
DECLARE
  sequence_name text;
BEGIN
  -- 如果之前已由 postgres 补建 tasks，只调整所有权，不重复创建。
  IF to_regclass('public.tasks') IS NOT NULL THEN
    ALTER TABLE public.tasks OWNER TO agent_ops;
  END IF;
  IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.set_updated_at() TO agent_ops;
  END IF;
  -- 已存在的迁移记录保持原内容，只准备后续维护权限。
  IF to_regnamespace('drizzle') IS NOT NULL THEN
    ALTER SCHEMA drizzle OWNER TO agent_ops;
  END IF;
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    ALTER TABLE drizzle.__drizzle_migrations OWNER TO agent_ops;
    sequence_name := pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE %s TO agent_ops', sequence_name::regclass);
    END IF;
  END IF;
END;
$existing_objects$;

COMMIT;

-- 两项权限预期均为 true。
SELECT has_schema_privilege('agent_ops', 'public', 'CREATE') AS can_create_tables,
       has_database_privilege('agent_ops', 'agent_ops', 'CREATE') AS can_create_schemas;

-- 已有业务表的 tableowner 预期均为 agent_ops。
SELECT schemaname, tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('accounts', 'audit_events', 'config_versions', 'idempotency_records',
                    'members', 'sessions', 'teams', 'tasks')
ORDER BY tablename;
