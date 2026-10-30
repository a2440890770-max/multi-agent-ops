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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_content_version_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "work_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_cancel_by_fk" FOREIGN KEY ("cancel_requested_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."execution_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_attempt_fk" FOREIGN KEY ("task_id","origin_attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_creator_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_active_task_idx" ON "execution_attempts" USING btree ("task_id") WHERE "execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification');--> statement-breakpoint
CREATE INDEX "execution_attempts_due_idx" ON "execution_attempts" USING btree ("next_run_at") WHERE "execution_attempts"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_attempt_fk" FOREIGN KEY ("id","current_attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_content_fk" FOREIGN KEY ("id","current_content_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_task_time_idx" ON "audit_events" USING btree ("task_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_generation_check" CHECK ("tasks"."work_generation" >= 0);
--> statement-breakpoint
UPDATE "audit_events" a SET "task_id" = t."id" FROM "tasks" t WHERE a."target_type" = 'task' AND a."target_id" = t."id"::text;
