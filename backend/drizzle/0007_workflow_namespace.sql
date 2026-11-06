ALTER TABLE "manual_decisions" RENAME TO "workflow_manual_decisions";--> statement-breakpoint
ALTER TABLE "review_cycles" RENAME TO "workflow_review_cycles";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "current_review_cycle_id" TO "workflow_review_cycle_id";--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_status_check";--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_trigger_check";--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_mode_check";--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_records_check";--> statement-breakpoint
ALTER TABLE "workflow_manual_decisions" DROP CONSTRAINT "manual_decisions_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_manual_decisions" DROP CONSTRAINT "manual_decisions_review_fk";
--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_requested_by_members_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_content_fk";
--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" DROP CONSTRAINT "review_cycles_attempt_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_current_review_fk";
--> statement-breakpoint
ALTER TABLE "workflow_manual_decisions" ADD CONSTRAINT "workflow_manual_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_manual_decisions" ADD CONSTRAINT "manual_decisions_review_fk" FOREIGN KEY ("task_id","review_cycle_id") REFERENCES "public"."workflow_review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "workflow_review_cycles_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "workflow_review_cycles_requested_by_members_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_content_fk" FOREIGN KEY ("task_id","input_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workflow_review_fk" FOREIGN KEY ("id","workflow_review_cycle_id") REFERENCES "public"."workflow_review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_status_check" CHECK ("workflow_review_cycles"."status" IN ('queued','running','completed','failed','cancelled'));--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_trigger_check" CHECK ("workflow_review_cycles"."trigger" IN ('initial_generation','manual_submit'));--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_mode_check" CHECK ("workflow_review_cycles"."executor_mode" IN ('mock','agent'));--> statement-breakpoint
ALTER TABLE "workflow_review_cycles" ADD CONSTRAINT "review_cycles_records_check" CHECK (jsonb_typeof("workflow_review_cycles"."records") = 'array');
--> statement-breakpoint
ALTER INDEX manual_decisions_pkey RENAME TO workflow_manual_decisions_pkey;
--> statement-breakpoint
ALTER INDEX review_cycles_pkey RENAME TO workflow_review_cycles_pkey;
