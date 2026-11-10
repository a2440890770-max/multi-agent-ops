-- Generated structure; composite unique keys are ordered before their dependent foreign keys.
CREATE TABLE "github_hot_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_hot_snapshots_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "github_hot_snapshots_scope_id_key" UNIQUE("task_id","attempt_id","id"),
	CONSTRAINT "github_hot_snapshots_attempt_key" UNIQUE("task_id","attempt_id"),
	CONSTRAINT "github_hot_snapshots_provider_check" CHECK ("github_hot_snapshots"."provider" = 'xxapi'),
	CONSTRAINT "github_hot_snapshots_snapshot_check" CHECK ((jsonb_typeof("github_hot_snapshots"."snapshot") = 'object' AND jsonb_typeof("github_hot_snapshots"."snapshot"->'list') = 'object' AND "github_hot_snapshots"."snapshot"->'list'->>'id' = "github_hot_snapshots"."id"::text AND "github_hot_snapshots"."snapshot"->'list'->>'provider' = "github_hot_snapshots"."provider" AND ("github_hot_snapshots"."snapshot"->'list'->>'fetchedAt')::timestamptz = "github_hot_snapshots"."fetched_at" AND jsonb_typeof("github_hot_snapshots"."snapshot"->'list'->'items') = 'array' AND length(btrim("github_hot_snapshots"."snapshot"->>'parserVersion')) > 0 AND "github_hot_snapshots"."snapshot" ? 'rawResponse') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "project_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"hot_list_snapshot_id" uuid NOT NULL,
	"candidate_id" text NOT NULL,
	"project" jsonb NOT NULL,
	"selected_by" uuid NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_selections_task_key" UNIQUE("task_id"),
	CONSTRAINT "project_selections_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "project_selections_project_check" CHECK ((length(btrim("project_selections"."candidate_id")) > 0 AND jsonb_typeof("project_selections"."project") = 'object' AND "project_selections"."project"->>'selectionId' = "project_selections"."id"::text AND "project_selections"."project"->>'candidateId' = "project_selections"."candidate_id" AND "project_selections"."project"->>'hotListSnapshotId' = "project_selections"."hot_list_snapshot_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "research_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"parent_asset_id" text,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "research_assets_scope_id_key" UNIQUE("attempt_id","authorization_id","source_id","id"),
	CONSTRAINT "research_assets_storage_key" UNIQUE("storage_key"),
	CONSTRAINT "research_assets_kind_check" CHECK ("research_assets"."kind" IN ('video','audio','transcript','frame')),
	CONSTRAINT "research_assets_identity_check" CHECK (length(btrim("research_assets"."id")) > 0 AND length(btrim("research_assets"."source_id")) > 0 AND ("research_assets"."parent_asset_id" IS NULL OR "research_assets"."parent_asset_id" <> "research_assets"."id")),
	CONSTRAINT "research_assets_hash_check" CHECK ("research_assets"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "research_assets_metadata_check" CHECK (jsonb_typeof("research_assets"."metadata") = 'object'),
	CONSTRAINT "research_assets_storage_check" CHECK (length(btrim("research_assets"."storage_key")) > 0 AND "research_assets"."storage_key" !~ '^/' AND "research_assets"."storage_key" !~ '(^|/)\.\.(/|$)' AND position(chr(92) in "research_assets"."storage_key") = 0)
);
--> statement-breakpoint
CREATE TABLE "research_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"scope" jsonb NOT NULL,
	"base_result_id" text,
	"authorized_by" uuid NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_step_id" uuid,
	CONSTRAINT "research_authorizations_attempt_id_key" UNIQUE("attempt_id","id"),
	CONSTRAINT "research_authorizations_scope_key" UNIQUE("task_id","attempt_id","id"),
	CONSTRAINT "research_authorizations_step_key" UNIQUE("consumed_by_step_id"),
	CONSTRAINT "research_authorizations_mode_check" CHECK ("research_authorizations"."mode" IN ('initial','supplement')),
	CONSTRAINT "research_authorizations_scope_check" CHECK (jsonb_typeof("research_authorizations"."scope") = 'object'),
	CONSTRAINT "research_authorizations_base_check" CHECK (("research_authorizations"."mode" = 'initial' AND "research_authorizations"."base_result_id" IS NULL) OR ("research_authorizations"."mode" = 'supplement' AND "research_authorizations"."base_result_id" IS NOT NULL)),
	CONSTRAINT "research_authorizations_consumption_check" CHECK (("research_authorizations"."consumed_at" IS NULL AND "research_authorizations"."consumed_by_step_id" IS NULL) OR ("research_authorizations"."consumed_at" IS NOT NULL AND "research_authorizations"."consumed_by_step_id" IS NOT NULL AND "research_authorizations"."consumed_at" >= "research_authorizations"."authorized_at"))
);
--> statement-breakpoint
CREATE TABLE "research_registries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"input_snapshot_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "research_registries_authorization_key" UNIQUE("authorization_id"),
	CONSTRAINT "research_registries_snapshot_check" CHECK ((jsonb_typeof("research_registries"."snapshot") = 'object' AND "research_registries"."snapshot"->>'schemaVersion' = '1.0' AND "research_registries"."snapshot"->'execution'->>'taskId' = "research_registries"."task_id"::text AND "research_registries"."snapshot"->'execution'->>'attemptId' = "research_registries"."attempt_id"::text AND "research_registries"."snapshot"->'execution'->>'stepId' = "research_registries"."step_id"::text AND "research_registries"."snapshot"->'execution'->>'inputSnapshotId' = "research_registries"."input_snapshot_id"::text AND "research_registries"."snapshot"->>'authorizationId' = "research_registries"."authorization_id"::text AND jsonb_typeof("research_registries"."snapshot"->'sources') = 'array' AND jsonb_typeof("research_registries"."snapshot"->'materials') = 'array' AND jsonb_typeof("research_registries"."snapshot"->'calls') = 'array') IS TRUE),
	CONSTRAINT "research_registries_time_check" CHECK ("research_registries"."updated_at" >= "research_registries"."created_at")
);
--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_status_check";
--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_mode_check";
--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_scenario_check";
--> statement-breakpoint
ALTER TABLE "execution_steps" DROP CONSTRAINT "execution_steps_ordinal_check";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_execution_status_check";
--> statement-breakpoint
DROP INDEX "execution_attempts_active_task_idx";
--> statement-breakpoint
ALTER TABLE "execution_attempts" ALTER COLUMN "simulation_scenario" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "tool_name" text;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "sdk_session_id" text;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "sdk_tool_use_id" text;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "parent_call_id" uuid;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "input_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD COLUMN "authorization_id" uuid;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "parent_step_id" uuid;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "authorization_id" uuid;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "input_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "frozen_input" jsonb;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "validated_output" jsonb;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "runtime_metadata" jsonb;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "result_id" text;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "result_version" integer;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "parent_result_id" text;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_scope_id_key" UNIQUE("task_id","attempt_id","id");
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_sdk_tool_key" UNIQUE("attempt_id","sdk_session_id","sdk_tool_use_id");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_input_key" UNIQUE("attempt_id","id","input_snapshot_id");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_authorized_key" UNIQUE("attempt_id","id","authorization_id");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_result_key" UNIQUE("attempt_id","result_id");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_result_version_key" UNIQUE("attempt_id","result_version");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_result_parent_key" UNIQUE("attempt_id","parent_result_id");
--> statement-breakpoint
ALTER TABLE "github_hot_snapshots" ADD CONSTRAINT "github_hot_snapshots_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_selected_by_members_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_snapshot_fk" FOREIGN KEY ("task_id","attempt_id","hot_list_snapshot_id") REFERENCES "public"."github_hot_snapshots"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_assets" ADD CONSTRAINT "research_assets_authorization_fk" FOREIGN KEY ("task_id","attempt_id","authorization_id") REFERENCES "public"."research_authorizations"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_assets" ADD CONSTRAINT "research_assets_parent_fk" FOREIGN KEY ("attempt_id","authorization_id","source_id","parent_asset_id") REFERENCES "public"."research_assets"("attempt_id","authorization_id","source_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_authorizations" ADD CONSTRAINT "research_authorizations_authorized_by_members_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_authorizations" ADD CONSTRAINT "research_authorizations_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_authorizations" ADD CONSTRAINT "research_authorizations_selection_fk" FOREIGN KEY ("task_id","selection_id") REFERENCES "public"."project_selections"("task_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_authorizations" ADD CONSTRAINT "research_authorizations_base_result_fk" FOREIGN KEY ("attempt_id","base_result_id") REFERENCES "public"."execution_steps"("attempt_id","result_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_authorizations" ADD CONSTRAINT "research_authorizations_consumed_step_fk" FOREIGN KEY ("attempt_id","consumed_by_step_id","id") REFERENCES "public"."execution_steps"("attempt_id","id","authorization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_registries" ADD CONSTRAINT "research_registries_authorization_fk" FOREIGN KEY ("task_id","attempt_id","authorization_id") REFERENCES "public"."research_authorizations"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_registries" ADD CONSTRAINT "research_registries_step_fk" FOREIGN KEY ("attempt_id","step_id","authorization_id") REFERENCES "public"."execution_steps"("attempt_id","id","authorization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "research_registries" ADD CONSTRAINT "research_registries_input_fk" FOREIGN KEY ("attempt_id","step_id","input_snapshot_id") REFERENCES "public"."execution_steps"("attempt_id","id","input_snapshot_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "research_assets_source_idx" ON "research_assets" USING btree ("authorization_id","source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "research_authorizations_initial_idx" ON "research_authorizations" USING btree ("attempt_id") WHERE "research_authorizations"."mode" = 'initial';
--> statement-breakpoint
CREATE UNIQUE INDEX "research_authorizations_pending_idx" ON "research_authorizations" USING btree ("attempt_id") WHERE "research_authorizations"."consumed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_parent_fk" FOREIGN KEY ("task_id","attempt_id","parent_call_id") REFERENCES "public"."task_execution_calls"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_input_fk" FOREIGN KEY ("attempt_id","step_id","input_snapshot_id") REFERENCES "public"."execution_steps"("attempt_id","id","input_snapshot_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_authorization_fk" FOREIGN KEY ("task_id","attempt_id","authorization_id") REFERENCES "public"."research_authorizations"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_step_authorization_fk" FOREIGN KEY ("attempt_id","step_id","authorization_id") REFERENCES "public"."execution_steps"("attempt_id","id","authorization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_parent_fk" FOREIGN KEY ("attempt_id","parent_step_id") REFERENCES "public"."execution_steps"("attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_authorization_fk" FOREIGN KEY ("attempt_id","authorization_id") REFERENCES "public"."research_authorizations"("attempt_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_result_parent_fk" FOREIGN KEY ("attempt_id","parent_result_id") REFERENCES "public"."execution_steps"("attempt_id","result_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_steps_research_authorization_idx" ON "execution_steps" USING btree ("authorization_id") WHERE "execution_steps"."role" = 'research' AND "execution_steps"."authorization_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_active_task_idx" ON "execution_attempts" USING btree ("task_id") WHERE "execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content');
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_agent_snapshot_check" CHECK ("execution_attempts"."executor_mode" <> 'agent' OR ("execution_attempts"."config_snapshot"->>'mode' = 'agent' AND "execution_attempts"."config_snapshot"->>'executorVersion' = '1' AND jsonb_typeof("execution_attempts"."config_snapshot"->'configuration') = 'object') IS TRUE);
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_wait_check" CHECK (("execution_attempts"."status" NOT IN ('awaiting_selection','awaiting_materials','awaiting_content') OR "execution_attempts"."executor_mode" = 'agent') AND ("execution_attempts"."executor_mode" <> 'agent' OR "execution_attempts"."status" NOT IN ('awaiting_clarification','awaiting_selection','awaiting_materials','awaiting_content') OR ("execution_attempts"."executor_id" IS NULL AND "execution_attempts"."active_since" IS NULL AND "execution_attempts"."next_run_at" IS NULL)));
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_status_check" CHECK ("execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content', 'ready', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_mode_check" CHECK ("execution_attempts"."executor_mode" IN ('mock','agent'));
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_scenario_check" CHECK ((("execution_attempts"."executor_mode" = 'mock' AND "execution_attempts"."simulation_scenario" IN ('success', 'failure', 'clarification')) OR ("execution_attempts"."executor_mode" = 'agent' AND "execution_attempts"."simulation_scenario" IS NULL)) IS TRUE);
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_parent_check" CHECK ("task_execution_calls"."parent_call_id" IS NULL OR "task_execution_calls"."parent_call_id" <> "task_execution_calls"."id");
--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_sdk_check" CHECK (("task_execution_calls"."sdk_tool_use_id" IS NULL OR ("task_execution_calls"."sdk_session_id" IS NOT NULL AND "task_execution_calls"."tool_name" IS NOT NULL)) AND ("task_execution_calls"."tool_name" IS NULL OR length(btrim("task_execution_calls"."tool_name")) > 0) AND ("task_execution_calls"."sdk_session_id" IS NULL OR length(btrim("task_execution_calls"."sdk_session_id")) > 0) AND ("task_execution_calls"."sdk_tool_use_id" IS NULL OR length(btrim("task_execution_calls"."sdk_tool_use_id")) > 0));
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_parent_check" CHECK ("execution_steps"."parent_step_id" IS NULL OR "execution_steps"."parent_step_id" <> "execution_steps"."id");
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_input_check" CHECK (("execution_steps"."input_snapshot_id" IS NULL AND "execution_steps"."frozen_input" IS NULL) OR ("execution_steps"."input_snapshot_id" IS NOT NULL AND (jsonb_typeof("execution_steps"."frozen_input") = 'object' AND "execution_steps"."frozen_input"->'execution'->>'attemptId' = "execution_steps"."attempt_id"::text AND "execution_steps"."frozen_input"->'execution'->>'stepId' = "execution_steps"."id"::text AND "execution_steps"."frozen_input"->'execution'->>'inputSnapshotId' = "execution_steps"."input_snapshot_id"::text) IS TRUE));
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_output_check" CHECK ("execution_steps"."validated_output" IS NULL OR ("execution_steps"."status" = 'completed' AND "execution_steps"."frozen_input" IS NOT NULL AND jsonb_typeof("execution_steps"."validated_output") = 'object'));
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_metadata_check" CHECK ("execution_steps"."runtime_metadata" IS NULL OR jsonb_typeof("execution_steps"."runtime_metadata") = 'object');
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_result_check" CHECK (("execution_steps"."result_id" IS NULL AND "execution_steps"."result_version" IS NULL AND "execution_steps"."parent_result_id" IS NULL AND ("execution_steps"."role" <> 'research' OR "execution_steps"."validated_output" IS NULL)) OR ("execution_steps"."role" = 'research' AND "execution_steps"."authorization_id" IS NOT NULL AND "execution_steps"."result_id" IS NOT NULL AND "execution_steps"."result_version" >= 1 AND (("execution_steps"."result_version" = 1 AND "execution_steps"."parent_result_id" IS NULL) OR ("execution_steps"."result_version" > 1 AND "execution_steps"."parent_result_id" IS NOT NULL AND "execution_steps"."parent_result_id" <> "execution_steps"."result_id")) AND ("execution_steps"."validated_output"->>'id' = "execution_steps"."result_id" AND ("execution_steps"."validated_output"->>'version')::integer = "execution_steps"."result_version" AND "execution_steps"."validated_output"->>'parentResultId' IS NOT DISTINCT FROM "execution_steps"."parent_result_id" AND "execution_steps"."validated_output"->'execution'->>'attemptId' = "execution_steps"."attempt_id"::text AND "execution_steps"."validated_output"->'execution'->>'stepId' = "execution_steps"."id"::text AND "execution_steps"."validated_output"->'execution'->>'inputSnapshotId' = "execution_steps"."input_snapshot_id"::text AND "execution_steps"."validated_output"->>'authorizationId' = "execution_steps"."authorization_id"::text) IS TRUE) IS TRUE);
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_frozen_time_check" CHECK ("execution_steps"."frozen_input" IS NULL OR ((("execution_steps"."status" IN ('queued','running')) = ("execution_steps"."finished_at" IS NULL)) AND ("execution_steps"."status" <> 'running' OR "execution_steps"."started_at" IS NOT NULL) AND ("execution_steps"."status" <> 'completed' OR "execution_steps"."started_at" IS NOT NULL) AND ("execution_steps"."started_at" IS NULL OR "execution_steps"."finished_at" IS NULL OR "execution_steps"."finished_at" >= "execution_steps"."started_at")));
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_ordinal_check" CHECK ("execution_steps"."ordinal" >= 0);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_execution_status_check" CHECK ("tasks"."execution_status" IN ('awaiting_clarification', 'awaiting_selection', 'awaiting_materials', 'awaiting_content', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled'));
--> statement-breakpoint
-- Custom protections are not represented by Drizzle snapshots. No business rows are backfilled.
CREATE FUNCTION research_history_immutable_v14() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'research history is immutable' USING ERRCODE='23514';
END; $$;
--> statement-breakpoint
CREATE TRIGGER github_hot_snapshots_history BEFORE UPDATE OR DELETE ON github_hot_snapshots FOR EACH ROW EXECUTE FUNCTION research_history_immutable_v14();
--> statement-breakpoint
CREATE TRIGGER project_selections_history BEFORE UPDATE OR DELETE ON project_selections FOR EACH ROW EXECUTE FUNCTION research_history_immutable_v14();
--> statement-breakpoint
CREATE TRIGGER research_assets_history BEFORE UPDATE OR DELETE ON research_assets FOR EACH ROW EXECUTE FUNCTION research_history_immutable_v14();
--> statement-breakpoint
-- Serialize research writes with cancellation: task -> attempt -> step, as in the executor.
CREATE FUNCTION research_live_attempt_v14(p_task_id uuid, p_attempt_id uuid, p_running boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM tasks WHERE id=p_task_id FOR UPDATE;
  PERFORM 1 FROM execution_attempts a JOIN tasks t ON t.id=a.task_id
    WHERE a.id=p_attempt_id AND a.task_id=p_task_id AND a.executor_mode='agent'
      AND t.lifecycle='open' AND t.current_attempt_id=a.id AND t.work_generation=a.generation
      AND a.cancel_requested_at IS NULL
      AND a.status IN ('queued','running','awaiting_clarification','awaiting_selection','awaiting_materials','awaiting_content')
      AND (NOT p_running OR (a.status='running' AND a.claim_token IS NOT NULL AND a.lease_expires_at>clock_timestamp()))
    FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research attempt is no longer current or executable' USING ERRCODE='23514';
  END IF;
END; $$;
--> statement-breakpoint
CREATE FUNCTION github_hot_snapshot_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,false);
  IF EXISTS (SELECT 1 FROM project_selections WHERE task_id=NEW.task_id) THEN
    RAISE EXCEPTION 'selected tasks retain their original hot list across attempts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER github_hot_snapshots_selection BEFORE INSERT ON github_hot_snapshots FOR EACH ROW EXECUTE FUNCTION github_hot_snapshot_guard_v14();
--> statement-breakpoint
CREATE FUNCTION project_selection_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate jsonb;
BEGIN
  PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,false);
  IF NOT EXISTS (SELECT 1 FROM tasks t JOIN members m ON m.team_id=t.team_id
      WHERE t.id=NEW.task_id AND m.id=NEW.selected_by AND m.status='active') THEN
    RAISE EXCEPTION 'selection actor must be an active member of the task team' USING ERRCODE='23514';
  END IF;
  SELECT item INTO STRICT candidate FROM github_hot_snapshots h,
    LATERAL jsonb_array_elements(h.snapshot->'list'->'items') item
    WHERE h.id=NEW.hot_list_snapshot_id AND h.task_id=NEW.task_id AND h.attempt_id=NEW.attempt_id
      AND item->>'id'=NEW.candidate_id;
  IF (candidate->>'title'=NEW.project->>'name' AND candidate->>'repositoryUrl'=NEW.project->>'repositoryUrl') IS NOT TRUE THEN
    RAISE EXCEPTION 'selection must match the acquired candidate' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER project_selections_candidate BEFORE INSERT ON project_selections FOR EACH ROW EXECUTE FUNCTION project_selection_guard_v14();
--> statement-breakpoint
CREATE FUNCTION research_authorization_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest_result text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'research authorization history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.consumed_by_step_id IS NULL
      OR (to_jsonb(NEW)-ARRAY['consumed_at','consumed_by_step_id']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['consumed_at','consumed_by_step_id']) THEN
      RAISE EXCEPTION 'research authorization can only be consumed once' USING ERRCODE='23514';
    END IF;
    PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,true);
    PERFORM 1 FROM execution_steps s WHERE s.id=NEW.consumed_by_step_id
      AND s.attempt_id=NEW.attempt_id AND s.authorization_id=NEW.id AND s.role='research'
      AND s.status='running' AND s.frozen_input IS NOT NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'authorization consumption requires its running research step' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_step_id IS NOT NULL THEN
      RAISE EXCEPTION 'insert an unconsumed authorization before claiming it' USING ERRCODE='23514';
    END IF;
    PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,false);
    IF NOT EXISTS (SELECT 1 FROM tasks t JOIN members m ON m.team_id=t.team_id
        WHERE t.id=NEW.task_id AND m.id=NEW.authorized_by AND m.status='active') THEN
      RAISE EXCEPTION 'authorization actor must be an active member of the task team' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT result_id INTO latest_result FROM execution_steps
    WHERE attempt_id=NEW.attempt_id AND result_id IS NOT NULL ORDER BY result_version DESC LIMIT 1;
  IF (NEW.mode='initial' AND latest_result IS NOT NULL)
    OR (NEW.mode='supplement' AND NEW.base_result_id IS DISTINCT FROM latest_result) THEN
    RAISE EXCEPTION 'research authorization must reference the current attempt report' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER research_authorizations_history BEFORE INSERT OR UPDATE OR DELETE ON research_authorizations FOR EACH ROW EXECUTE FUNCTION research_authorization_guard_v14();
--> statement-breakpoint
CREATE FUNCTION research_step_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_task uuid; auth research_authorizations%ROWTYPE; previous_version integer; chosen_project jsonb;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'execution step history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (OLD.status IN ('completed','failed','cancelled') AND NEW IS DISTINCT FROM OLD)
      OR ROW(NEW.id,NEW.attempt_id,NEW.ordinal,NEW.role,NEW.parent_step_id,NEW.authorization_id)
        IS DISTINCT FROM ROW(OLD.id,OLD.attempt_id,OLD.ordinal,OLD.role,OLD.parent_step_id,OLD.authorization_id)
      OR (OLD.frozen_input IS NOT NULL AND ROW(NEW.input_snapshot_id,NEW.frozen_input)
        IS DISTINCT FROM ROW(OLD.input_snapshot_id,OLD.frozen_input)) THEN
      RAISE EXCEPTION 'step identity, frozen input and terminal history are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.parent_step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution_steps p
      WHERE p.id=NEW.parent_step_id AND p.attempt_id=NEW.attempt_id AND p.ordinal<NEW.ordinal) THEN
    RAISE EXCEPTION 'parent step must precede the child in the same attempt' USING ERRCODE='23514';
  END IF;
  SELECT task_id INTO owner_task FROM execution_attempts WHERE id=NEW.attempt_id;
  IF NEW.frozen_input IS NOT NULL THEN
    IF NEW.frozen_input->'execution'->>'taskId' IS DISTINCT FROM owner_task::text THEN
      RAISE EXCEPTION 'frozen step input belongs to another task' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' THEN
      PERFORM research_live_attempt_v14(owner_task,NEW.attempt_id,false);
    ELSIF OLD.frozen_input IS NULL THEN
      PERFORM research_live_attempt_v14(owner_task,NEW.attempt_id,false);
    END IF;
    IF NEW.role='research' THEN
      SELECT * INTO auth FROM research_authorizations WHERE id=NEW.authorization_id AND attempt_id=NEW.attempt_id;
      SELECT project INTO chosen_project FROM project_selections WHERE id=auth.selection_id;
      IF auth.id IS NULL OR (NEW.frozen_input->'authorization'->>'id'=auth.id::text
          AND NEW.frozen_input->'authorization'->>'mode'=auth.mode
          AND NEW.frozen_input->'selectedProject'=chosen_project) IS NOT TRUE THEN
        RAISE EXCEPTION 'research input must match its authorization and selection' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.validated_output IS NOT NULL THEN
    IF TG_OP='INSERT' THEN
      PERFORM research_live_attempt_v14(owner_task,NEW.attempt_id,true);
    ELSIF OLD.validated_output IS NULL THEN
      PERFORM research_live_attempt_v14(owner_task,NEW.attempt_id,true);
    END IF;
    IF NEW.role='supervisor' THEN
      IF (NEW.validated_output->>'decision' IN ('awaiting_selection','needs_clarification','needs_materials','ready_for_content')) IS NOT TRUE THEN
        RAISE EXCEPTION 'invalid supervisor decision discriminator' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.role='research' THEN
      IF auth.id IS NULL OR auth.consumed_by_step_id IS DISTINCT FROM NEW.id OR auth.consumed_at IS NULL
        OR (NEW.validated_output->'execution'->>'taskId'=owner_task::text
          AND NEW.validated_output->'selectedProject'=chosen_project) IS NOT TRUE
        OR NOT EXISTS (SELECT 1 FROM research_registries WHERE authorization_id=auth.id AND step_id=NEW.id) THEN
        RAISE EXCEPTION 'research output requires consumed authorization and registered evidence' USING ERRCODE='23514';
      END IF;
      IF auth.mode='initial' THEN
        IF NEW.result_version IS DISTINCT FROM 1 OR NEW.parent_result_id IS NOT NULL THEN
          RAISE EXCEPTION 'initial research starts a new attempt report chain' USING ERRCODE='23514';
        END IF;
      ELSE
        SELECT result_version INTO previous_version FROM execution_steps
          WHERE attempt_id=NEW.attempt_id AND result_id=auth.base_result_id;
        IF NEW.parent_result_id IS DISTINCT FROM auth.base_result_id
          OR NEW.result_version IS DISTINCT FROM previous_version+1 THEN
          RAISE EXCEPTION 'supplement must extend the authorized report version' USING ERRCODE='23514';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'D9 structured outputs only support supervisor and research' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER execution_steps_research_history BEFORE INSERT OR UPDATE OR DELETE ON execution_steps FOR EACH ROW EXECUTE FUNCTION research_step_guard_v14();
--> statement-breakpoint
CREATE FUNCTION research_registry_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth research_authorizations%ROWTYPE; chosen_project jsonb;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'research registry history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['snapshot','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['snapshot','updated_at']) THEN
    RAISE EXCEPTION 'research registry ownership is immutable' USING ERRCODE='23514';
  END IF;
  PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,true);
  SELECT * INTO auth FROM research_authorizations WHERE id=NEW.authorization_id;
  PERFORM 1 FROM execution_steps s WHERE s.id=NEW.step_id AND s.attempt_id=NEW.attempt_id
    AND s.status='running' AND auth.consumed_at IS NOT NULL AND auth.consumed_by_step_id=s.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'registry can only be written by its active research step' USING ERRCODE='23514';
  END IF;
  SELECT project INTO chosen_project FROM project_selections WHERE id=auth.selection_id;
  IF NEW.snapshot->'selectedProject' IS DISTINCT FROM chosen_project THEN
    RAISE EXCEPTION 'registry selection does not match authorization' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER research_registries_history BEFORE INSERT OR UPDATE OR DELETE ON research_registries FOR EACH ROW EXECUTE FUNCTION research_registry_guard_v14();
--> statement-breakpoint
CREATE FUNCTION research_asset_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth research_authorizations%ROWTYPE; parent_kind text;
BEGIN
  PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,true);
  SELECT * INTO auth FROM research_authorizations WHERE id=NEW.authorization_id;
  PERFORM 1 FROM execution_steps s WHERE s.id=auth.consumed_by_step_id AND s.attempt_id=NEW.attempt_id
    AND s.status='running' AND auth.consumed_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM research_registries r,
      LATERAL jsonb_array_elements(r.snapshot->'sources') item
      WHERE r.authorization_id=NEW.authorization_id AND item->'source'->>'id'=NEW.source_id) THEN
    RAISE EXCEPTION 'asset requires an active research step and registered source' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='video' THEN
    IF NEW.parent_asset_id IS NOT NULL THEN
      RAISE EXCEPTION 'video is a root research asset' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT kind INTO parent_kind FROM research_assets WHERE id=NEW.parent_asset_id
      AND attempt_id=NEW.attempt_id AND authorization_id=NEW.authorization_id AND source_id=NEW.source_id;
    IF (NEW.kind IN ('audio','frame') AND parent_kind='video'
        OR NEW.kind='transcript' AND parent_kind='audio') IS NOT TRUE THEN
      RAISE EXCEPTION 'derived asset must reference its actual registered parent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER research_assets_parent BEFORE INSERT ON research_assets FOR EACH ROW EXECUTE FUNCTION research_asset_guard_v14();
--> statement-breakpoint
CREATE FUNCTION execution_identity_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.task_id,NEW.attempt_no,NEW.generation,NEW.executor_mode,NEW.simulation_scenario,NEW.config_snapshot,NEW.requested_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt_no,OLD.generation,OLD.executor_mode,OLD.simulation_scenario,OLD.config_snapshot,OLD.requested_by,OLD.created_at) THEN
    RAISE EXCEPTION 'execution identity and configuration snapshot are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_identity BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION execution_identity_guard_v14();
--> statement-breakpoint
CREATE FUNCTION execution_call_guard_v14() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'execution call history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.parent_call_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_execution_calls p
      WHERE p.id=NEW.parent_call_id AND p.task_id=NEW.task_id AND p.attempt_id=NEW.attempt_id
        AND p.started_at<=NEW.started_at) THEN
      RAISE EXCEPTION 'parent call must already exist in the same attempt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'running'
    OR ROW(NEW.id,NEW.task_id,NEW.attempt_id,NEW.step_id,NEW.call_no,NEW.retry_no,NEW.kind,NEW.pricing_ref,NEW.reserved_tokens,NEW.reserved_cost_micros_cny,NEW.started_at,NEW.deadline_at,NEW.parent_call_id,NEW.input_snapshot_id,NEW.authorization_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt_id,OLD.step_id,OLD.call_no,OLD.retry_no,OLD.kind,OLD.pricing_ref,OLD.reserved_tokens,OLD.reserved_cost_micros_cny,OLD.started_at,OLD.deadline_at,OLD.parent_call_id,OLD.input_snapshot_id,OLD.authorization_id)
    OR (OLD.tool_name IS NOT NULL AND NEW.tool_name IS DISTINCT FROM OLD.tool_name)
    OR (OLD.sdk_session_id IS NOT NULL AND NEW.sdk_session_id IS DISTINCT FROM OLD.sdk_session_id)
    OR (OLD.sdk_tool_use_id IS NOT NULL AND NEW.sdk_tool_use_id IS DISTINCT FROM OLD.sdk_tool_use_id)
    OR (NEW.status='running' AND (to_jsonb(NEW)-ARRAY['tool_name','sdk_session_id','sdk_tool_use_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['tool_name','sdk_session_id','sdk_tool_use_id'])) THEN
    RAISE EXCEPTION 'call identity and terminal history are immutable; trace fields can only be filled once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER execution_calls_history ON task_execution_calls;
--> statement-breakpoint
CREATE TRIGGER execution_calls_history BEFORE INSERT OR UPDATE OR DELETE ON task_execution_calls FOR EACH ROW EXECUTE FUNCTION execution_call_guard_v14();
