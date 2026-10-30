ALTER TABLE "tasks" ALTER COLUMN "execution_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "execution_status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reference_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lifecycle" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reference_inputs_check" CHECK (jsonb_typeof("tasks"."reference_inputs") = 'array');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lifecycle_check" CHECK ("tasks"."lifecycle" IN ('open', 'terminated', 'published'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_revision_check" CHECK ("tasks"."revision" >= 1);