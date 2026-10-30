CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"platform" varchar(20) DEFAULT 'weibo' NOT NULL,
	"platform_account_id" varchar(128),
	"display_name" varchar(100) NOT NULL,
	"authorization_status" varchar(20) DEFAULT 'unconfigured' NOT NULL,
	"official_publish_available" boolean DEFAULT false NOT NULL,
	"credential_ref" text,
	"authorization_expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"current_config_version" integer,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "accounts_team_id_key" UNIQUE("team_id"),
	CONSTRAINT "accounts_platform_check" CHECK ("accounts"."platform" = 'weibo'),
	CONSTRAINT "accounts_authorization_status_check" CHECK ("accounts"."authorization_status" IN ('unconfigured', 'valid', 'expired')),
	CONSTRAINT "accounts_current_config_version_check" CHECK ("accounts"."current_config_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" varchar(128),
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" varchar(128),
	"before_revision" integer,
	"after_revision" integer,
	"outcome" varchar(20) NOT NULL,
	"reason" text,
	"request_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" IN ('member', 'worker', 'system')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" IN ('succeeded', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile" text NOT NULL,
	"tone" text NOT NULL,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_ref" varchar(128) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"tool_version" varchar(128) NOT NULL,
	"max_auto_revisions" integer DEFAULT 3 NOT NULL,
	"change_reason" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "config_versions_account_version_unique" UNIQUE("account_id","version"),
	CONSTRAINT "config_versions_version_check" CHECK ("config_versions"."version" >= 1),
	CONSTRAINT "config_versions_forbidden_topics_check" CHECK (jsonb_typeof("config_versions"."forbidden_topics") = 'array'),
	CONSTRAINT "config_versions_rules_check" CHECK (jsonb_typeof("config_versions"."rules") = 'array'),
	CONSTRAINT "config_versions_max_auto_revisions_check" CHECK ("config_versions"."max_auto_revisions" = 3)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_hash" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"encrypted_replay" "bytea",
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_scope_key_unique" UNIQUE("scope_hash","key_hash"),
	CONSTRAINT "idempotency_records_status_check" CHECK ("idempotency_records"."status" IN ('processing', 'completed')),
	CONSTRAINT "idempotency_records_response_status_check" CHECK ("idempotency_records"."response_status" >= 100 AND "idempotency_records"."response_status" <= 599),
	CONSTRAINT "idempotency_expiry_after_creation" CHECK ("idempotency_records"."expires_at" > "idempotency_records"."created_at")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"login" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"role" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"auth_version" integer DEFAULT 1 NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "members_login_key" UNIQUE("login"),
	CONSTRAINT "members_role_check" CHECK ("members"."role" IN ('admin', 'operator')),
	CONSTRAINT "members_status_check" CHECK ("members"."status" IN ('active', 'disabled')),
	CONSTRAINT "members_version_check" CHECK ("members"."version" >= 1),
	CONSTRAINT "members_auth_version_check" CHECK ("members"."auth_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_secret" "bytea" NOT NULL,
	"issued_auth_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP + interval '8 hours' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(50),
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "sessions_issued_auth_version_check" CHECK ("sessions"."issued_auth_version" >= 1),
	CONSTRAINT "sessions_expiry_after_creation" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"original_request" text NOT NULL,
	"execution_status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_execution_status_check" CHECK ("tasks"."execution_status" IN ('awaiting_clarification', 'queued', 'running', 'needs_human', 'ready', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_current_config_version_fk" FOREIGN KEY ("id","current_config_version") REFERENCES "public"."config_versions"("account_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_request_id_idx" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "audit_events_team_time_idx" ON "audit_events" USING btree ("team_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "config_versions_updated_by_idx" ON "config_versions" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "members_login_normalized_unique_idx" ON "members" USING btree (lower(btrim("login"::text)));--> statement-breakpoint
CREATE INDEX "members_team_id_idx" ON "members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "sessions_member_id_idx" ON "sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
-- Drizzle Kit does not model triggers; retain these reviewed SQL objects here.
CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER accounts_set_updated_at_trg BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER members_set_updated_at_trg BEFORE UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER teams_set_updated_at_trg BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
