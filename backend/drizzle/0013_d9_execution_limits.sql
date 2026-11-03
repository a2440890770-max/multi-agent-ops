CREATE TABLE "task_execution_budgets" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"limits" jsonb NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"charged_tokens" bigint DEFAULT 0 NOT NULL,
	"charged_cost_micros_cny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "execution_budgets_usage_check" CHECK ("task_execution_budgets"."calls" >= 0 AND "task_execution_budgets"."charged_tokens" >= 0 AND "task_execution_budgets"."charged_cost_micros_cny" >= 0)
);
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD COLUMN "execution_limits" jsonb;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD COLUMN "active_elapsed_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD COLUMN "active_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "next_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_execution_budgets" ADD CONSTRAINT "task_execution_budgets_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_attempt_id_key" UNIQUE("attempt_id","id");--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_step_fk" FOREIGN KEY ("attempt_id","step_id") REFERENCES "public"."execution_steps"("attempt_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_calls" ADD CONSTRAINT "execution_calls_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_calls_active_step_idx" ON "task_execution_calls" USING btree ("step_id") WHERE "task_execution_calls"."status" = 'running';--> statement-breakpoint
CREATE INDEX "execution_calls_task_idx" ON "task_execution_calls" USING btree ("task_id","started_at");--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_elapsed_check" CHECK ("execution_attempts"."active_elapsed_ms" >= 0);--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_retry_check" CHECK ("execution_steps"."retry_count" >= 0 AND "execution_steps"."retry_count" <= 10);--> statement-breakpoint
CREATE FUNCTION execution_call_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' OR NEW.status = 'running' OR
    ROW(NEW.id,NEW.task_id,NEW.attempt_id,NEW.step_id,NEW.call_no,NEW.retry_no,NEW.kind,NEW.pricing_ref,NEW.reserved_tokens,NEW.reserved_cost_micros_cny,NEW.started_at,NEW.deadline_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt_id,OLD.step_id,OLD.call_no,OLD.retry_no,OLD.kind,OLD.pricing_ref,OLD.reserved_tokens,OLD.reserved_cost_micros_cny,OLD.started_at,OLD.deadline_at) THEN
    RAISE EXCEPTION 'execution call history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER execution_calls_history BEFORE UPDATE OR DELETE ON task_execution_calls FOR EACH ROW EXECUTE FUNCTION execution_call_guard_v13();
--> statement-breakpoint
CREATE FUNCTION execution_budget_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.limits IS DISTINCT FROM OLD.limits OR NEW.calls < OLD.calls THEN
    RAISE EXCEPTION 'execution budget identity and limits are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER execution_budgets_history BEFORE UPDATE OR DELETE ON task_execution_budgets FOR EACH ROW EXECUTE FUNCTION execution_budget_guard_v13();
--> statement-breakpoint
CREATE FUNCTION execution_policy_guard_v13() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.execution_limits IS NOT NULL AND NEW.execution_limits IS DISTINCT FROM OLD.execution_limits) OR NEW.active_elapsed_ms < OLD.active_elapsed_ms THEN
    RAISE EXCEPTION 'execution policy and accumulated time cannot be reset' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_policy BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION execution_policy_guard_v13();
