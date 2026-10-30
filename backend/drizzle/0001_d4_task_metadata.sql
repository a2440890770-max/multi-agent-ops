ALTER TABLE "tasks" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_step" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_team_created_at_idx" ON "tasks" USING btree ("team_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");
--> statement-breakpoint
COMMENT ON COLUMN public.tasks.created_by IS '任务创建人成员ID';
--> statement-breakpoint
COMMENT ON COLUMN public.tasks.team_id IS '任务所属团队ID';
--> statement-breakpoint
COMMENT ON COLUMN public.tasks.current_step IS '当前执行步骤';
--> statement-breakpoint
COMMENT ON COLUMN public.tasks.error_message IS '执行错误信息';
