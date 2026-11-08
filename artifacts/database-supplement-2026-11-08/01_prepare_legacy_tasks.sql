-- 仅用于截图中的七张 D3 基础表、缺少 tasks 的旧库。
-- 先备份并停止后端/执行器；缺少权限时先以 postgres 执行 00_prepare_migration_role.sql。
-- 连接 agent_ops 数据库；事务内使用 agent_ops 身份创建，确保表所有权正确。
-- 执行后必须运行 npm run db:baseline，通过核对后再执行 02 或 db:migrate。
-- 不要跳过基线核对；本文件只补初始 tasks，后续迁移将其升级为完整任务表。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
DO $target_guard$
BEGIN
  IF current_database() <> 'agent_ops' THEN
    RAISE EXCEPTION '请连接现有业务数据库 agent_ops 后执行；当前库为 %', current_database();
  END IF;
END;
$target_guard$;
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
  FOREACH table_name IN ARRAY ARRAY['accounts', 'audit_events', 'config_versions', 'idempotency_records', 'members', 'sessions', 'teams']
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
LOCK TABLE public.accounts, public.audit_events, public.config_versions, public.idempotency_records, public.members, public.sessions, public.teams IN SHARE MODE;
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"original_request" text NOT NULL,
	"execution_status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_execution_status_check" CHECK ("tasks"."execution_status" IN ('awaiting_clarification', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled'))
);
COMMIT;
