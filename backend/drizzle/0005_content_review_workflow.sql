CREATE TABLE "manual_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"review_cycle_id" uuid NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid,
	"trigger" text NOT NULL,
	"input_version_id" uuid NOT NULL,
	"current_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"generation" integer NOT NULL,
	"executor_mode" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"technical_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone,
	"error" jsonb,
	CONSTRAINT "review_cycles_task_id_key" UNIQUE("task_id","id"),
	CONSTRAINT "review_cycles_status_check" CHECK ("review_cycles"."status" IN ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "review_cycles_trigger_check" CHECK ("review_cycles"."trigger" IN ('initial_generation','manual_submit')),
	CONSTRAINT "review_cycles_mode_check" CHECK ("review_cycles"."executor_mode" IN ('mock','agent')),
	CONSTRAINT "review_cycles_records_check" CHECK (jsonb_typeof("review_cycles"."records") = 'array')
);
--> statement-breakpoint
ALTER TABLE "task_contents" DROP CONSTRAINT "task_contents_attempt_key";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_counts_check";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_status_check";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_mode_check";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_scenario_check";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_cancel_scope_check";--> statement-breakpoint
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_finish_check";--> statement-breakpoint
ALTER TABLE "execution_steps" DROP CONSTRAINT "execution_steps_ordinal_check";--> statement-breakpoint
ALTER TABLE "task_contents" ALTER COLUMN "origin_attempt_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "output_content_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "technical_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_contents" ADD COLUMN "parent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "task_contents" ADD COLUMN "source_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_contents" ADD COLUMN "revision_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_review_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "terminated_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "terminated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "termination_reason" text;--> statement-breakpoint
ALTER TABLE "manual_decisions" ADD CONSTRAINT "manual_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_decisions" ADD CONSTRAINT "manual_decisions_review_fk" FOREIGN KEY ("task_id","review_cycle_id") REFERENCES "public"."review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_requested_by_members_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_content_fk" FOREIGN KEY ("task_id","input_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_contents_attempt_round_key" ON "task_contents" USING btree ("origin_attempt_id","revision_round") WHERE "task_contents"."source_kind" = 'agent';--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_counts_check" CHECK ("execution_attempts"."attempt_no" >= 1 AND "execution_attempts"."generation" >= 1 AND "execution_attempts"."config_version" >= 1 AND "execution_attempts"."auto_revision_count" BETWEEN 0 AND 3);--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_status_check" CHECK ("execution_attempts"."status" IN ('queued', 'running', 'awaiting_clarification', 'manual_required', 'ready', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_mode_check" CHECK ("execution_attempts"."executor_mode" IN ('mock','agent'));--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_scenario_check" CHECK ("execution_attempts"."simulation_scenario" IN ('success', 'failure', 'clarification', 'review_failure', 'factual_failure'));--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_cancel_scope_check" CHECK ("execution_attempts"."cancel_scope" IS NULL OR "execution_attempts"."cancel_scope" IN ('stop_attempt','terminate_task'));--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_finish_check" CHECK (("execution_attempts"."status" IN ('manual_required','ready','failed','cancelled')) = ("execution_attempts"."finished_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_ordinal_check" CHECK ("execution_steps"."ordinal" BETWEEN 0 AND 9);--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_round_check" CHECK ("task_contents"."revision_round" BETWEEN 0 AND 3);--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_source_check" CHECK ("task_contents"."source_kind" IN ('agent','manual'));