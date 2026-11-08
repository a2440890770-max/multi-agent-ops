-- 在完成业务表迁移后，使用有创建角色及授权权限的管理员执行。
-- 数据库仍为 agent_ops；新增的是数据库登录角色 agent_ops_app。
-- 对象所有权保留给管理员/迁移身份；业务角色只读写业务数据。
-- 新建角色时必须替换下方密码；已有普通角色会保留原密码。
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $target_guard$
BEGIN
  IF current_database() <> 'agent_ops' THEN
    RAISE EXCEPTION '请连接现有业务数据库 agent_ops 后执行；当前库为 %', current_database();
  END IF;
END;
$target_guard$;
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
