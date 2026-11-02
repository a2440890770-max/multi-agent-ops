CREATE TABLE "task_publication_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"fact_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "publication_verifications_fact_key" UNIQUE("operation_id","fact_hash"),
	CONSTRAINT "publication_verifications_binding_check" CHECK (("task_publication_verifications"."data"->>'id' = "task_publication_verifications"."id"::text AND "task_publication_verifications"."data"->>'operationId' = "task_publication_verifications"."operation_id"::text AND "task_publication_verifications"."data"->>'dispatchId' = "task_publication_verifications"."dispatch_id"::text AND "task_publication_verifications"."data"->>'actorId' = "task_publication_verifications"."actor_id"::text AND "task_publication_verifications"."data"->>'method' = 'manual' AND "task_publication_verifications"."data"->>'conclusion' IN ('published','not_published','unknown') AND length(btrim("task_publication_verifications"."data"->>'note')) > 0 AND "task_publication_verifications"."data"->>'resultingStatus' IN ('verification_required','published','failed') AND "task_publication_verifications"."fact_hash" ~ '^[a-f0-9]{64}$') IS TRUE),
	CONSTRAINT "publication_verifications_body_check" CHECK ("task_publication_verifications"."data"->>'observedBody' IS NULL OR ("task_publication_verifications"."data"->>'observedContentHash' = encode(sha256(convert_to("task_publication_verifications"."data"->>'observedBody','UTF8')),'hex')) IS TRUE),
	CONSTRAINT "publication_verifications_confirmation_check" CHECK (("task_publication_verifications"."data"->>'conclusion' <> 'published' OR (("task_publication_verifications"."data"->>'manualConfirmed')::boolean AND "task_publication_verifications"."data"->>'observedBody' IS NOT NULL AND "task_publication_verifications"."data"->>'observedAccountUid' IS NOT NULL AND "task_publication_verifications"."data"->>'url' IS NOT NULL)) IS TRUE AND ("task_publication_verifications"."data"->>'conclusion' <> 'not_published' OR (("task_publication_verifications"."data"->>'manualConfirmed')::boolean AND ("task_publication_verifications"."data"->>'previousDispatchFenced')::boolean)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "task_publication_verifications" ADD CONSTRAINT "task_publication_verifications_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_publication_verifications" ADD CONSTRAINT "publication_verifications_dispatch_fk" FOREIGN KEY ("operation_id","dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION publication_verification_guard_v8() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication verification history is immutable' USING ERRCODE='23514';
END; $$;
--> statement-breakpoint
CREATE TRIGGER publication_verification_immutable BEFORE UPDATE OR DELETE ON task_publication_verifications FOR EACH ROW EXECUTE FUNCTION publication_verification_guard_v8();
