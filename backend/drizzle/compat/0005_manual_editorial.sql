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
--> statement-breakpoint
CREATE TABLE "task_review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "task_decisions_binding_check" CHECK ("task_review_decisions"."data"->>'id' = "task_review_decisions"."id"::text AND length(btrim("task_review_decisions"."data"->>'reason')) > 0)
);
--> statement-breakpoint
CREATE TABLE "task_review_cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "task_reviews_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "task_reviews_binding_check" CHECK ("task_review_cycles"."data"->>'id' = "task_review_cycles"."id"::text AND "task_review_cycles"."data"->>'taskId' = "task_review_cycles"."task_id"::text AND "task_review_cycles"."data"->>'currentVersionId' = "task_review_cycles"."content_version_id"::text AND ("task_review_cycles"."data"->>'configVersion')::integer = "task_review_cycles"."config_version")
);
--> statement-breakpoint
ALTER TABLE "task_contents" ALTER COLUMN "origin_attempt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_contents" ADD COLUMN "parent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "task_contents" ADD COLUMN "source_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_review_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approval_status" text DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_review_fk" FOREIGN KEY ("task_id","review_cycle_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_version_approvals" ADD CONSTRAINT "task_approvals_config_fk" FOREIGN KEY ("account_id","config_version") REFERENCES "public"."config_versions"("account_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_review_decisions" ADD CONSTRAINT "task_decisions_review_fk" FOREIGN KEY ("task_id","review_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_review_cycles" ADD CONSTRAINT "task_reviews_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_parent_fk" FOREIGN KEY ("task_id","parent_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_review_fk" FOREIGN KEY ("id","current_review_cycle_id") REFERENCES "public"."task_review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_approval_fk" FOREIGN KEY ("id","current_approval_id") REFERENCES "public"."task_version_approvals"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_source_check" CHECK ("task_contents"."source_kind" IN ('agent','manual') AND ("task_contents"."source_kind" <> 'agent' OR "task_contents"."origin_attempt_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_body_hash_check" CHECK ("task_contents"."content_hash" = encode(sha256(convert_to("task_contents"."body", 'UTF8')), 'hex'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approval_status_check" CHECK ("tasks"."approval_status" IN ('not_requested','pending','approved','invalidated'));--> statement-breakpoint
CREATE FUNCTION editorial_history_immutable_v5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable editorial history' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_contents_immutable BEFORE UPDATE OR DELETE ON task_contents FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
--> statement-breakpoint
CREATE TRIGGER task_reviews_immutable BEFORE UPDATE OR DELETE ON task_review_cycles FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
--> statement-breakpoint
CREATE TRIGGER task_decisions_immutable BEFORE UPDATE OR DELETE ON task_review_decisions FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='config_versions'::regclass AND tgname='config_versions_immutable') THEN
    CREATE TRIGGER config_versions_immutable BEFORE UPDATE OR DELETE ON config_versions FOR EACH ROW EXECUTE FUNCTION editorial_history_immutable_v5();
  END IF;
END; $$;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER task_approvals_binding BEFORE UPDATE OR DELETE ON task_version_approvals FOR EACH ROW EXECUTE FUNCTION editorial_approval_binding_v5();
--> statement-breakpoint
CREATE FUNCTION editorial_parent_guard_v5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_contents p WHERE p.id=NEW.parent_version_id AND p.task_id=NEW.task_id AND p.version_no<NEW.version_no
  ) THEN RAISE EXCEPTION 'parent must be an earlier version of the same task' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER task_contents_parent_guard BEFORE INSERT ON task_contents FOR EACH ROW EXECUTE FUNCTION editorial_parent_guard_v5();
