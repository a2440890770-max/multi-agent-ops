CREATE TABLE "task_publication_send_claims" (
	"dispatch_id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_publication_dispatches" DROP CONSTRAINT "publication_dispatches_channel_check";--> statement-breakpoint
ALTER TABLE "task_publication_send_claims" ADD CONSTRAINT "publication_send_claims_dispatch_fk" FOREIGN KEY ("operation_id","dispatch_id") REFERENCES "public"."task_publication_dispatches"("operation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_dispatches_active_operation_idx" ON "task_publication_dispatches" USING btree ("operation_id") WHERE "task_publication_dispatches"."status" IN ('awaiting_manual','publishing','verification_required');--> statement-breakpoint
ALTER TABLE "task_publication_dispatches" ADD CONSTRAINT "publication_dispatches_channel_check" CHECK ("task_publication_dispatches"."channel" IN ('manual','official_api','simulation'));
--> statement-breakpoint
CREATE FUNCTION publication_send_claim_guard_v10() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication send claims are immutable' USING ERRCODE='23514';
END; $$;
--> statement-breakpoint
CREATE TRIGGER publication_send_claim_immutable BEFORE UPDATE OR DELETE ON task_publication_send_claims FOR EACH ROW EXECUTE FUNCTION publication_send_claim_guard_v10();
