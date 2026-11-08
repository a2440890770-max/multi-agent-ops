-- 仅用于 agent_ops_app 已存在、能够连接 agent_ops，但尚未获得业务表权限的情况。
-- 使用拥有这 21 张业务表的 agent_ops 迁移账号，或 postgres 超级用户执行。
-- 只补数据读写及后续表的默认授权，不重设密码，不授予建表或角色管理权限。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';

DO $app_guard$
DECLARE
  app_oid oid;
BEGIN
  IF current_database() <> 'agent_ops' THEN
    RAISE EXCEPTION '请连接 agent_ops 业务数据库。';
  END IF;
  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'agent_ops_app';
  IF app_oid IS NULL THEN
    RAISE EXCEPTION 'agent_ops_app 尚不存在，请先由 postgres 执行 03_create_app_role.sql。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE oid = app_oid
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = app_oid) THEN
    RAISE EXCEPTION '业务角色存在额外管理权限或角色成员资格，请先核对。';
  END IF;
  IF NOT has_database_privilege('agent_ops_app', current_database(), 'CONNECT')
     OR NOT has_schema_privilege('agent_ops_app', 'public', 'USAGE') THEN
    RAISE EXCEPTION '业务角色缺少数据库 CONNECT 或 public USAGE，请先由 postgres 执行 03_create_app_role.sql。';
  END IF;
  IF has_database_privilege('agent_ops_app', current_database(), 'CREATE')
     OR has_schema_privilege('agent_ops_app', 'public', 'CREATE')
     OR EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = app_oid)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = app_oid)
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname IN ('public', 'drizzle') AND c.relowner = app_oid) THEN
    RAISE EXCEPTION '业务角色仍有 DDL 权限或对象所有权，请先核对管理员和业务角色的分离配置。';
  END IF;
END;
$app_guard$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.accounts,
  public.audit_events,
  public.clarification_answers,
  public.config_versions,
  public.execution_attempts,
  public.execution_steps,
  public.idempotency_records,
  public.members,
  public.sessions,
  public.task_contents,
  public.task_execution_budgets,
  public.task_execution_calls,
  public.task_publication_dispatches,
  public.task_publication_operations,
  public.task_publication_send_claims,
  public.task_publication_verifications,
  public.task_review_cycles,
  public.task_review_decisions,
  public.task_version_approvals,
  public.tasks,
  public.teams
TO agent_ops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agent_ops IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agent_ops IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agent_ops_app;

COMMIT;
