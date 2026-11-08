-- 从已核对并登记的 0000 基线升级至 0013；生成日期 2026-11-08。
-- 前置：先执行 01，再用管理员连接运行 npm run db:baseline 并确认成功。
-- 以下内容直接取自仓库原始迁移，保留约束、索引、函数、触发器和原始迁移哈希。
-- 与 npm run db:migrate 二选一。本文件不适用于中途已经升级过的库，也不重复执行。
-- 请在同一连接整份执行；任何错误后先 ROLLBACK，禁止跳过错误继续提交。
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
SELECT pg_advisory_xact_lock(1835100527, 168101);
DO $baseline_guard$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '缺少迁移基线，请先运行 npm run db:baseline，禁止直接补写迁移记录。';
  END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 1 OR NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
    WHERE hash = 'eb36625a2df75dc33906a096bdcb408f64293cc986cb5590c16c2e989d4014f1' AND created_at = 1793253402572
  ) THEN
    RAISE EXCEPTION '要求仅有已核对的 0000 基线；已升级的数据库请用 npm run db:migrate。';
  END IF;
END;
$baseline_guard$;

-- 0001_d4_task_metadata.sql
ALTER TABLE "tasks" ADD COLUMN "created_by" uuid;
ALTER TABLE "tasks" ADD COLUMN "team_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "current_step" text;
ALTER TABLE "tasks" ADD COLUMN "error_message" text;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "tasks_team_created_at_idx" ON "tasks" USING btree ("team_id","created_at" DESC NULLS FIRST);
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");
COMMENT ON COLUMN public.tasks.created_by IS '任务创建人成员ID';
COMMENT ON COLUMN public.tasks.team_id IS '任务所属团队ID';
COMMENT ON COLUMN public.tasks.current_step IS '当前执行步骤';
COMMENT ON COLUMN public.tasks.error_message IS '执行错误信息';
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('60f44dda8ce876939b923d45eca6daeff981acaf9c24d0032416101f34ccf146', 1793265492723);


-- 0002_d4_create_task.sql
ALTER TABLE "tasks" ALTER COLUMN "execution_status" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "execution_status" DROP NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "account_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "reference_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "lifecycle" text DEFAULT 'open' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reference_inputs_check" CHECK (jsonb_typeof("tasks"."reference_inputs") = 'array');
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lifecycle_check" CHECK ("tasks"."lifecycle" IN ('open', 'terminated', 'published'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_revision_check" CHECK ("tasks"."revision" >= 1);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('3cafac9547262dc9d2fe05e0704f63d21ec2057ee8b400a74c1721713a212129', 1793272254070);


-- 0003_d4_execution_attempts.sql
CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"current_step" text,
	"auto_revision_count" integer DEFAULT 0 NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"executor_mode" text DEFAULT 'mock' NOT NULL,
	"simulation_scenario" text NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"clarifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_scope" text,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" uuid,
	"cancel_reason" text,
	"stopped_at" timestamp with time zone,
	"error" jsonb,
	"next_run_at" timestamp with time zone,
	CONSTRAINT "execution_attempts_task_id_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "execution_attempts_task_no_key" UNIQUE("task_id","attempt_no"),
	CONSTRAINT "execution_attempts_counts_check" CHECK ("execution_attempts"."attempt_no" >= 1 AND "execution_attempts"."generation" >= 1 AND "execution_attempts"."config_version" >= 1 AND "execution_attempts"."auto_revision_count" = 0),
	CONSTRAINT "execution_attempts_status_check" CHECK ("execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification', 'ready', 'failed', 'cancelled')),
	CONSTRAINT "execution_attempts_mode_check" CHECK ("execution_attempts"."executor_mode" = 'mock'),
	CONSTRAINT "execution_attempts_scenario_check" CHECK ("execution_attempts"."simulation_scenario" IN ('success', 'failure', 'clarification')),
	CONSTRAINT "execution_attempts_cancel_scope_check" CHECK ("execution_attempts"."cancel_scope" IS NULL OR "execution_attempts"."cancel_scope" = 'stop_attempt'),
	CONSTRAINT "execution_attempts_snapshot_check" CHECK (jsonb_typeof("execution_attempts"."config_snapshot") = 'object' AND jsonb_typeof("execution_attempts"."clarifications") = 'array'),
	CONSTRAINT "execution_attempts_finish_check" CHECK (("execution_attempts"."status" IN ('ready','failed','cancelled')) = ("execution_attempts"."finished_at" IS NOT NULL))
);
CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error" jsonb,
	CONSTRAINT "execution_steps_attempt_ordinal_key" UNIQUE("attempt_id","ordinal"),
	CONSTRAINT "execution_steps_ordinal_check" CHECK ("execution_steps"."ordinal" BETWEEN 0 AND 3),
	CONSTRAINT "execution_steps_role_check" CHECK ("execution_steps"."role" IN ('supervisor','research','content','review')),
	CONSTRAINT "execution_steps_status_check" CHECK ("execution_steps"."status" IN ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "execution_steps_duration_check" CHECK ("execution_steps"."duration_ms" >= 0)
);
CREATE TABLE "task_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"origin_attempt_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "task_contents_task_id_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "task_contents_task_version_key" UNIQUE("task_id","version_no"),
	CONSTRAINT "task_contents_attempt_key" UNIQUE("origin_attempt_id"),
	CONSTRAINT "task_contents_version_check" CHECK ("task_contents"."version_no" >= 1),
	CONSTRAINT "task_contents_hash_check" CHECK ("task_contents"."content_hash" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "audit_events" ADD COLUMN "task_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "current_attempt_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "current_content_version_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "work_generation" integer DEFAULT 0 NOT NULL;
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_cancel_by_fk" FOREIGN KEY ("cancel_requested_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_attempts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_attempt_fk" FOREIGN KEY ("task_id","origin_attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_creator_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "execution_attempts_active_task_idx" ON "execution_attempts" USING btree ("task_id") WHERE "execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification');
CREATE INDEX "execution_attempts_due_idx" ON "execution_attempts" USING btree ("next_run_at") WHERE "execution_attempts"."status" IN ('queued', 'running');
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_attempt_fk" FOREIGN KEY ("id","current_attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_content_fk" FOREIGN KEY ("id","current_content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "audit_events_task_time_idx" ON "audit_events" USING btree ("task_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_generation_check" CHECK ("tasks"."work_generation" >= 0);
UPDATE "audit_events" a SET "task_id" = t."id" FROM "tasks" t WHERE a."target_type" = 'task' AND a."target_id" = t."id"::text;
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('208dd2ee8ed35de2c5013a96ee62c050a2759d4ccef1dc1bf2654604b3ba90e7', 1793277013761);


-- 0004_d4_clarification_answers.sql
CREATE TABLE "clarification_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"answered_by" uuid NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarification_answers_attempt_question_key" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "clarification_answers_text_check" CHECK (char_length("clarification_answers"."answer") BETWEEN 1 AND 4000 AND char_length(btrim("clarification_answers"."answer")) > 0 AND char_length("clarification_answers"."question") BETWEEN 1 AND 4000)
);
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_member_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "clarification_answers_task_idx" ON "clarification_answers" USING btree ("task_id");
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('80abb07545f6ca9e386a791ab75ba2e7ee73a2d9876c6ab1bfe5e7b1a83bc6a2', 1793278998771);


-- 0005_manual_editorial.sql
CREATE TABLE "task_version_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"review_cycle_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "task_approvals_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "task_approvals_binding_check" CHECK ("task_version_approvals"."data"->>'id' = "task_version_approvals"."id"::text AND "task_version_approvals"."data"->>'taskId' = "task_version_approvals"."task_id"::text AND "task_version_approvals"."data"->>'contentVersionId' = "task_version_approvals"."content_version_id"::text AND "task_version_approvals"."data"->>'reviewCycleId' = "task_version_approvals"."review_cycle_id"::text AND "task_version_approvals"."data"->>'accountId' = "task_version_approvals"."account_id"::text AND "task_version_approvals"."data"->>'status' IN ('approved','invalidated'))
);
CREATE TABLE "task_review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "task_decisions_binding_check" CHECK ("task_review_decisions"."data"->>'id' = "task_review_decisions"."id"::text AND length(btrim("task_review_decisions"."data"->>'reason')) > 0)
);
CREATE TABLE "task_review_cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "task_reviews_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "task_reviews_binding_check" CHECK ("task_review_cycles"."data"->>'id' = "task_review_cycles"."id"::text AND "task_review_cycles"."data"->>'taskId' = "task_review_cycles"."task_id"::text AND "task_review_cycles"."data"->>'currentVersionId' = "task_review_cycles"."content_version_id"::text AND ("task_review_cycles"."data"->>'configVersion')::integer = "task_review_cycles"."config_version")
);
ALTER TABLE "task_contents" ALTER COLUMN "origin_attempt_id" DROP NOT NULL;
ALTER TABLE "task_contents" ADD COLUMN "parent_version_id" uuid;
ALTER TABLE "task_contents" ADD COLUMN "source_kind" text DEFAULT 'agent' NOT NULL;
ALTER TABLE "tasks" ADD COLUMN "current_review_cycle_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "current_approval_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "approval_status" text DEFAULT 'not_requested' NOT NULL;
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_review_fk" FOREIGN KEY ("task_id","review_cycle_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_config_fk" FOREIGN KEY ("account_id","config_version") REFERENCES "public"."config_versions"("account_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_review_decisions" ADD CONSTRAINT "task_decisions_review_fk" FOREIGN KEY ("task_id","review_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_review_cycles" ADD CONSTRAINT "task_reviews_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_parent_fk" FOREIGN KEY ("task_id","parent_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_review_fk" FOREIGN KEY ("id","current_review_cycle_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_approval_fk" FOREIGN KEY ("id","current_approval_id") REFERENCES "public"."task_version_approvals"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_source_check" CHECK ("task_contents"."source_kind" IN ('agent','manual') AND ("task_contents"."source_kind" <> 'agent' OR "task_contents"."origin_attempt_id" IS NOT NULL));
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_body_hash_check" CHECK ("task_contents"."content_hash" = encode(sha256(convert_to("task_contents"."body", 'UTF8')), 'hex'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approval_status_check" CHECK ("tasks"."approval_status" IN ('not_requested','pending','approved','invalidated'));
CREATE FUNCTION editorial_history_immutable_v5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable editorial history' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER task_contents_immutable BEFORE UPDATE OR DELETE ON task_contents FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
CREATE TRIGGER task_reviews_immutable BEFORE UPDATE OR DELETE ON task_review_cycles FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
CREATE TRIGGER task_decisions_immutable BEFORE UPDATE OR DELETE ON task_review_decisions FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='config_versions'::regclass AND tgname='config_versions_immutable') THEN
    CREATE TRIGGER config_versions_immutable BEFORE UPDATE OR DELETE ON config_versions FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
  END IF;
END; $$;
CREATE FUNCTION editorial_approval_binding_v5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable approval history' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'data') IS DISTINCT FROM (to_jsonb(OLD)-'data')
    OR (NEW.data - ARRAY['status','invalidatedAt','invalidatedReason']) IS DISTINCT FROM (OLD.data - ARRAY['status','invalidatedAt','invalidatedReason'])
    OR OLD.data->>'status' <> 'approved' OR NEW.data->>'status' <> 'invalidated'
    OR coalesce(NEW.data->>'invalidatedAt','')='' OR coalesce(btrim(NEW.data->>'invalidatedReason'),'')='' THEN
    RAISE EXCEPTION 'approval binding is immutable; only invalidation is permitted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_approvals_binding BEFORE UPDATE OR DELETE ON task_version_approvals FOR EACH ROW EXECUTE FUNCTION editorial_approval_binding_v5();
CREATE FUNCTION editorial_parent_guard_v5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_contents p WHERE p.id=NEW.parent_version_id AND p.task_id=NEW.task_id AND p.version_no<NEW.version_no
  ) THEN RAISE EXCEPTION 'parent must be an earlier version of the same task' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_contents_parent_guard BEFORE INSERT ON task_contents FOR EACH ROW EXECUTE FUNCTION editorial_parent_guard_v5();
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('05484f8b9990ef1df7f40a7c7881977bcc769c2c3ec845064df13d14722ab616', 1793351546786);


-- 0006_d6_account_registration.sql
ALTER TABLE "accounts" ADD COLUMN "manual_publish_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "accounts" ADD COLUMN "registration_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "accounts" ADD COLUMN "registered_by" uuid;
ALTER TABLE "accounts" ADD COLUMN "registered_at" timestamp with time zone;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_registered_by_members_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_registration_version_check" CHECK ("accounts"."registration_version" >= 0);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_manual_registration_check" CHECK (NOT "accounts"."manual_publish_enabled" OR ("accounts"."registration_version" > 0 AND "accounts"."platform_account_id" IS NOT NULL AND "accounts"."platform_account_id" ~ '^[1-9][0-9]{0,19}$' AND "accounts"."registered_by" IS NOT NULL AND "accounts"."registered_at" IS NOT NULL));
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('4920bdd4eb2d5ff98da8bd890eb21834478c0cb2d3edba7a8482159387c9c36a', 1793595681987);


-- 0007_d6_manual_handoff.sql
CREATE TABLE "task_publication_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"dispatch_no" integer NOT NULL,
	"approval_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"provider_request_id" text,
	"platform_post_id" text,
	"url" text,
	"error" jsonb,
	CONSTRAINT "publication_dispatches_operation_id_key" UNIQUE("operation_id","id"),
	CONSTRAINT "publication_dispatches_number_key" UNIQUE("operation_id","dispatch_no"),
	CONSTRAINT "publication_dispatches_number_check" CHECK ("task_publication_dispatches"."dispatch_no" >= 1),
	CONSTRAINT "publication_dispatches_channel_check" CHECK ("task_publication_dispatches"."channel" IN ('manual','official_api')),
	CONSTRAINT "publication_dispatches_status_check" CHECK ("task_publication_dispatches"."status" IN ('awaiting_manual','publishing','verification_required','published','failed'))
);
CREATE TABLE "task_publication_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"account_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"current_dispatch_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "publication_operations_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "publication_operations_business_key" UNIQUE("task_id","content_version_id","account_id"),
	CONSTRAINT "publication_operations_approval_key" UNIQUE("id","approval_id"),
	CONSTRAINT "publication_operations_status_check" CHECK ("task_publication_operations"."status" IN ('awaiting_manual','publishing','verification_required','published','failed')),
	CONSTRAINT "publication_operations_snapshot_check" CHECK (("task_publication_operations"."snapshot"->'content'->>'id' = "task_publication_operations"."content_version_id"::text AND "task_publication_operations"."snapshot"->'content'->>'taskId' = "task_publication_operations"."task_id"::text AND "task_publication_operations"."snapshot"->'content'->>'contentHash' = "task_publication_operations"."content_hash" AND "task_publication_operations"."content_hash" = encode(sha256(convert_to("task_publication_operations"."snapshot"->'content'->>'body','UTF8')),'hex') AND "task_publication_operations"."snapshot"->'account'->>'id' = "task_publication_operations"."account_id"::text AND "task_publication_operations"."snapshot"->'account'->>'platformAccountId' ~ '^[1-9][0-9]{0,19}$' AND "task_publication_operations"."snapshot"->'approval'->>'id' = "task_publication_operations"."approval_id"::text AND "task_publication_operations"."snapshot"->'approval'->>'contentVersionId' = "task_publication_operations"."content_version_id"::text AND "task_publication_operations"."snapshot"->'approval'->>'accountId' = "task_publication_operations"."account_id"::text AND "task_publication_operations"."snapshot"->'approval'->>'contentHash' = "task_publication_operations"."content_hash" AND ("task_publication_operations"."snapshot"->>'configVersion')::integer = "task_publication_operations"."config_version") IS TRUE)
);
ALTER TABLE "tasks" ADD COLUMN "active_publish_operation_id" uuid;
ALTER TABLE "tasks" ADD COLUMN "published_operation_id" uuid;
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "task_publication_dispatches_started_by_members_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_operation_approval_fk" FOREIGN KEY ("operation_id","approval_id") REFERENCES "public"."task_publication_operations"("id","approval_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "task_publication_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "task_publication_operations_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_approval_fk" FOREIGN KEY ("task_id","approval_id") REFERENCES "public"."task_version_approvals"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_config_fk" FOREIGN KEY ("account_id","config_version") REFERENCES "public"."config_versions"("account_id","version") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_current_dispatch_fk" FOREIGN KEY ("id","current_dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "publication_operations_active_task_idx" ON "task_publication_operations" USING btree ("task_id") WHERE "task_publication_operations"."status" IN ('awaiting_manual','publishing','verification_required');
CREATE UNIQUE INDEX "publication_operations_published_task_idx" ON "task_publication_operations" USING btree ("task_id") WHERE "task_publication_operations"."status" = 'published';
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_active_publication_fk" FOREIGN KEY ("id","active_publish_operation_id") REFERENCES "public"."task_publication_operations"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_published_publication_fk" FOREIGN KEY ("id","published_operation_id") REFERENCES "public"."task_publication_operations"("task_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE task_publication_operations ALTER CONSTRAINT publication_operations_current_dispatch_fk DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION publication_snapshot_guard_v7() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication history is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','current_dispatch_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','current_dispatch_id','updated_at']) THEN
    RAISE EXCEPTION 'frozen publication snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER publication_snapshot_immutable BEFORE UPDATE OR DELETE ON task_publication_operations FOR EACH ROW EXECUTE FUNCTION publication_snapshot_guard_v7();
CREATE FUNCTION publication_dispatch_guard_v7() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication dispatch history is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','finished_at','provider_request_id','platform_post_id','url','error']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','finished_at','provider_request_id','platform_post_id','url','error']) THEN
    RAISE EXCEPTION 'publication dispatch binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER publication_dispatch_immutable BEFORE UPDATE OR DELETE ON task_publication_dispatches FOR EACH ROW EXECUTE FUNCTION publication_dispatch_guard_v7();
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('2a4e33160732dc67dd35af8797ba68c7b0e4af267524530f7de33b2e07622ee4', 1793599139768);


-- 0008_d6_publication_backfill.sql
CREATE TABLE "task_publication_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fact_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "publication_verifications_fact_key" UNIQUE("operation_id","fact_hash"),
	CONSTRAINT "publication_verifications_binding_check" CHECK (("task_publication_verifications"."data"->>'id' = "task_publication_verifications"."id"::text AND "task_publication_verifications"."data"->>'operationId' = "task_publication_verifications"."operation_id"::text AND "task_publication_verifications"."data"->>'dispatchId' = "task_publication_verifications"."dispatch_id"::text AND "task_publication_verifications"."data"->>'actorId' = "task_publication_verifications"."actor_id"::text AND "task_publication_verifications"."data"->>'method' = 'manual' AND "task_publication_verifications"."data"->>'conclusion' IN ('published','not_published','unknown') AND length(btrim("task_publication_verifications"."data"->>'note')) > 0 AND "task_publication_verifications"."data"->>'resultingStatus' IN ('verification_required','published','failed') AND "task_publication_verifications"."fact_hash" ~ '^[a-f0-9]{64}$') IS TRUE),
	CONSTRAINT "publication_verifications_body_check" CHECK ("task_publication_verifications"."data"->>'observedBody' IS NULL OR ("task_publication_verifications"."data"->>'observedContentHash' = encode(sha256(convert_to("task_publication_verifications"."data"->>'observedBody','UTF8')),'hex')) IS TRUE),
	CONSTRAINT "publication_verifications_confirmation_check" CHECK (("task_publication_verifications"."data"->>'conclusion' <> 'published' OR (("task_publication_verifications"."data"->>'manualConfirmed')::boolean AND "task_publication_verifications"."data"->>'observedBody' IS NOT NULL AND "task_publication_verifications"."data"->>'observedAccountUid' IS NOT NULL AND "task_publication_verifications"."data"->>'url' IS NOT NULL)) IS TRUE AND ("task_publication_verifications"."data"->>'conclusion' <> 'not_published' OR (("task_publication_verifications"."data"->>'manualConfirmed')::boolean AND ("task_publication_verifications"."data"->>'previousDispatchFenced')::boolean)) IS TRUE)
);
ALTER TABLE "task_publication_verifications" ADD CONSTRAINT "task_publication_verifications_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_verifications" ADD CONSTRAINT "publication_verifications_dispatch_fk" FOREIGN KEY ("operation_id","dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;
CREATE FUNCTION publication_verification_guard_v8() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication verification history is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER publication_verification_immutable BEFORE UPDATE OR DELETE ON task_publication_verifications FOR EACH ROW EXECUTE FUNCTION publication_verification_guard_v8();
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('9de6e5ff5aca62cb7fe26929a208a7e0868fc8020c99e3d9760ef531fd437479', 1793604841586);


-- 0009_d6_manual_publication_retry.sql
ALTER TABLE "task_publication_dispatches" ADD COLUMN "previous_dispatch_id" uuid;
ALTER TABLE "task_publication_dispatches" ADD COLUMN "reason" text;
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_previous_fk" FOREIGN KEY ("operation_id","previous_dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_previous_key" UNIQUE("operation_id","previous_dispatch_id");
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_retry_check" CHECK (("task_publication_dispatches"."dispatch_no"=1 AND "task_publication_dispatches"."previous_dispatch_id" IS NULL AND "task_publication_dispatches"."reason" IS NULL) OR ("task_publication_dispatches"."dispatch_no">1 AND "task_publication_dispatches"."previous_dispatch_id" IS NOT NULL AND length(btrim("task_publication_dispatches"."reason"))>0 AND "task_publication_dispatches"."reason" IS NOT NULL));
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('7de1f3a908bbf142cdd64f378ceccd632fb9f40fa74424601542540098cf1ae3', 1793610181387);


-- 0010_d7_publication_send_claims.sql
CREATE TABLE "task_publication_send_claims" (
	"dispatch_id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE "task_publication_dispatches" DROP CONSTRAINT "publication_dispatches_channel_check";
ALTER TABLE "task_publication_send_claims" ADD CONSTRAINT "publication_send_claims_dispatch_fk" FOREIGN KEY ("operation_id","dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "publication_dispatches_active_operation_idx" ON "task_publication_dispatches" USING btree ("operation_id") WHERE "task_publication_dispatches"."status" IN ('awaiting_manual','publishing','verification_required');
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_channel_check" CHECK ("task_publication_dispatches"."channel" IN ('manual','official_api','simulation'));
CREATE FUNCTION publication_send_claim_guard_v10() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication send claims are immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER publication_send_claim_immutable BEFORE UPDATE OR DELETE ON task_publication_send_claims FOR EACH ROW EXECUTE FUNCTION publication_send_claim_guard_v10();
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('c31a99328a75a01084607c60308d64cdceb3a6f36f2fe3a2ea7c0d1eeda608b7', 1793682557539);


-- 0011_d7_publication_preflight_termination.sql
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_cancel_scope_check";
ALTER TABLE "tasks" ADD COLUMN "terminated_by" uuid;
ALTER TABLE "tasks" ADD COLUMN "terminated_at" timestamp with time zone;
ALTER TABLE "tasks" ADD COLUMN "termination_reason" text;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_terminated_by_members_id_fk" FOREIGN KEY ("terminated_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_cancel_scope_check" CHECK ("execution_attempts"."cancel_scope" IS NULL OR "execution_attempts"."cancel_scope" IN ('stop_attempt','terminate_task'));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_termination_record_check" CHECK (("tasks"."terminated_by" IS NULL AND "tasks"."terminated_at" IS NULL AND "tasks"."termination_reason" IS NULL) OR ("tasks"."lifecycle" = 'terminated' AND "tasks"."terminated_by" IS NOT NULL AND "tasks"."terminated_at" IS NOT NULL AND "tasks"."termination_reason" IS NOT NULL AND length(btrim("tasks"."termination_reason")) > 0));
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('baced4ef12c81d3df7382f9edbdee302117de1e74cbdbd80c58e5c1c352fe119', 1793684665390);


-- 0012_d9_execution_ownership.sql
ALTER TABLE "execution_attempts" ADD COLUMN "executor_id" uuid;
ALTER TABLE "execution_attempts" ADD COLUMN "claim_token" uuid;
ALTER TABLE "execution_attempts" ADD COLUMN "claimed_at" timestamp with time zone;
ALTER TABLE "execution_attempts" ADD COLUMN "heartbeat_at" timestamp with time zone;
ALTER TABLE "execution_attempts" ADD COLUMN "lease_expires_at" timestamp with time zone;
ALTER TABLE "execution_attempts" ADD COLUMN "runtime_policy" jsonb;
ALTER TABLE "task_publication_send_claims" ADD COLUMN "expires_at" timestamp with time zone;
CREATE INDEX "execution_attempts_lease_idx" ON "execution_attempts" USING btree ("lease_expires_at") WHERE "execution_attempts"."status" = 'running';
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_lease_check" CHECK (("execution_attempts"."executor_id" IS NULL AND "execution_attempts"."claim_token" IS NULL AND "execution_attempts"."claimed_at" IS NULL AND "execution_attempts"."heartbeat_at" IS NULL AND "execution_attempts"."lease_expires_at" IS NULL) OR ("execution_attempts"."executor_id" IS NOT NULL AND "execution_attempts"."claim_token" IS NOT NULL AND "execution_attempts"."claimed_at" IS NOT NULL AND "execution_attempts"."heartbeat_at" IS NOT NULL AND "execution_attempts"."lease_expires_at" IS NOT NULL AND "execution_attempts"."lease_expires_at" >= "execution_attempts"."heartbeat_at" AND "execution_attempts"."heartbeat_at" >= "execution_attempts"."claimed_at"));
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('e263fa88925124e05eeb2381ee020314af26bbe019d95daf5bcb5ca91b4703f9', 1793689031881);


-- 0013_d9_execution_limits.sql
CREATE TABLE "task_execution_budgets" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"limits" jsonb NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"charged_tokens" bigint DEFAULT 0 NOT NULL,
	"charged_cost_micros_cny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "execution_budgets_usage_check" CHECK ("task_execution_budgets"."calls" >= 0 AND "task_execution_budgets"."charged_tokens" >= 0 AND "task_execution_budgets"."charged_cost_micros_cny" >= 0)
);
CREATE TABLE "task_execution_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"call_no" integer NOT NULL,
	"retry_no" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"pricing_ref" text NOT NULL,
	"reserved_tokens" bigint NOT NULL,
	"reserved_cost_micros_cny" bigint NOT NULL,
	"charged_tokens" bigint NOT NULL,
	"charged_cost_micros_cny" bigint NOT NULL,
	"tokens_known" boolean DEFAULT false NOT NULL,
	"cost_known" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" jsonb,
	CONSTRAINT "execution_calls_step_no_key" UNIQUE("step_id","call_no"),
	CONSTRAINT "execution_calls_counts_check" CHECK ("task_execution_calls"."call_no" >= 1 AND "task_execution_calls"."retry_no" >= 0 AND "task_execution_calls"."reserved_tokens" >= 0 AND "task_execution_calls"."reserved_cost_micros_cny" >= 0 AND "task_execution_calls"."charged_tokens" >= 0 AND "task_execution_calls"."charged_cost_micros_cny" >= 0),
	CONSTRAINT "execution_calls_kind_check" CHECK ("task_execution_calls"."kind" IN ('simulation','model','search','readonly')),
	CONSTRAINT "execution_calls_status_check" CHECK ("task_execution_calls"."status" IN ('running','succeeded','failed','timed_out','interrupted')),
	CONSTRAINT "execution_calls_time_check" CHECK ("task_execution_calls"."deadline_at" > "task_execution_calls"."started_at" AND ("task_execution_calls"."status" = 'running') = ("task_execution_calls"."finished_at" IS NULL))
);
ALTER TABLE "execution_attempts" ADD COLUMN "execution_limits" jsonb;
ALTER TABLE "execution_attempts" ADD COLUMN "active_elapsed_ms" integer DEFAULT 0 NOT NULL;
ALTER TABLE "execution_attempts" ADD COLUMN "active_since" timestamp with time zone;
ALTER TABLE "execution_steps" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "execution_steps" ADD COLUMN "next_call_at" timestamp with time zone;
ALTER TABLE "task_execution_budgets" ADD CONSTRAINT "task_execution_budgets_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_attempt_id_key" UNIQUE("attempt_id","id");
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_step_fk" FOREIGN KEY ("attempt_id","step_id") REFERENCES "public"."execution_steps"("attempt_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "execution_calls_active_step_idx" ON "task_execution_calls" USING btree ("step_id") WHERE "task_execution_calls"."status" = 'running';
CREATE INDEX "execution_calls_task_idx" ON "task_execution_calls" USING btree ("task_id","started_at");
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_elapsed_check" CHECK ("execution_attempts"."active_elapsed_ms" >= 0);
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_retry_check" CHECK ("execution_steps"."retry_count" >= 0 AND "execution_steps"."retry_count" <= 10);
CREATE FUNCTION execution_call_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' OR NEW.status = 'running' OR
    ROW(NEW.id,NEW.task_id,NEW.attempt_id,NEW.step_id,NEW.call_no,NEW.retry_no,NEW.kind,NEW.pricing_ref,NEW.reserved_tokens,NEW.reserved_cost_micros_cny,NEW.started_at,NEW.deadline_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt_id,OLD.step_id,OLD.call_no,OLD.retry_no,OLD.kind,OLD.pricing_ref,OLD.reserved_tokens,OLD.reserved_cost_micros_cny,OLD.started_at,OLD.deadline_at) THEN
    RAISE EXCEPTION 'execution call history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_calls_history BEFORE UPDATE OR DELETE ON task_execution_calls FOR EACH ROW EXECUTE FUNCTION execution_call_guard_v13();
CREATE FUNCTION execution_budget_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.limits IS DISTINCT FROM OLD.limits OR NEW.calls < OLD.calls THEN
    RAISE EXCEPTION 'execution budget identity and limits are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_budgets_history BEFORE UPDATE OR DELETE ON task_execution_budgets FOR EACH ROW EXECUTE FUNCTION execution_budget_guard_v13();
CREATE FUNCTION execution_policy_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.execution_limits IS NOT NULL AND NEW.execution_limits IS DISTINCT FROM OLD.execution_limits) OR NEW.active_elapsed_ms < OLD.active_elapsed_ms THEN
    RAISE EXCEPTION 'execution policy and accumulated time cannot be reset' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_attempts_policy BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION execution_policy_guard_v13();
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('e2ccb9398c9e2f2d4d0136b6da74ac98f9726dc275315198128a58f00accee74', 1793692701604);

COMMIT;
