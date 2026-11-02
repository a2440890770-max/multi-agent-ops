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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "active_publish_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "published_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "task_publication_dispatches_started_by_members_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_operation_approval_fk" FOREIGN KEY ("operation_id","approval_id") REFERENCES "public"."task_publication_operations"("id","approval_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "task_publication_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "task_publication_operations_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_content_fk" FOREIGN KEY ("task_id","content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_approval_fk" FOREIGN KEY ("task_id","approval_id") REFERENCES "public"."task_version_approvals"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_config_fk" FOREIGN KEY ("account_id","config_version") REFERENCES "public"."config_versions"("account_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_operations" ADD CONSTRAINT "publication_operations_current_dispatch_fk" FOREIGN KEY ("id","current_dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_operations_active_task_idx" ON "task_publication_operations" USING btree ("task_id") WHERE "task_publication_operations"."status" IN ('awaiting_manual','publishing','verification_required');--> statement-breakpoint
CREATE UNIQUE INDEX "publication_operations_published_task_idx" ON "task_publication_operations" USING btree ("task_id") WHERE "task_publication_operations"."status" = 'published';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_active_publication_fk" FOREIGN KEY ("id","active_publish_operation_id") REFERENCES "public"."task_publication_operations"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_published_publication_fk" FOREIGN KEY ("id","published_operation_id") REFERENCES "public"."task_publication_operations"("task_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE task_publication_operations ALTER CONSTRAINT publication_operations_current_dispatch_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION publication_snapshot_guard_v7() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication history is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','current_dispatch_id','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','current_dispatch_id','updated_at']) THEN
    RAISE EXCEPTION 'frozen publication snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER publication_snapshot_immutable BEFORE UPDATE OR DELETE ON task_publication_operations FOR EACH ROW EXECUTE FUNCTION publication_snapshot_guard_v7();
--> statement-breakpoint
CREATE FUNCTION publication_dispatch_guard_v7() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication dispatch history is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','finished_at','provider_request_id','platform_post_id','url','error']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','finished_at','provider_request_id','platform_post_id','url','error']) THEN
    RAISE EXCEPTION 'publication dispatch binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER publication_dispatch_immutable BEFORE UPDATE OR DELETE ON task_publication_dispatches FOR EACH ROW EXECUTE FUNCTION publication_dispatch_guard_v7();
