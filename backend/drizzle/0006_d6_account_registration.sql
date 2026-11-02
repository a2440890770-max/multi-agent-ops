ALTER TABLE "accounts" ADD COLUMN "manual_publish_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "registration_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "registered_by" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_registered_by_members_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_registration_version_check" CHECK ("accounts"."registration_version" >= 0);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_manual_registration_check" CHECK (NOT "accounts"."manual_publish_enabled" OR ("accounts"."registration_version" > 0 AND "accounts"."platform_account_id" IS NOT NULL AND "accounts"."platform_account_id" ~ '^[1-9][0-9]{0,19}$' AND "accounts"."registered_by" IS NOT NULL AND "accounts"."registered_at" IS NOT NULL));