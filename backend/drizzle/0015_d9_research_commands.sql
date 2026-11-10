CREATE TABLE "research_submission_materials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"client_ref" text,
	"source_id" text NOT NULL,
	"material_id" text,
	"material_version" integer,
	"lineage_root_material_id" text,
	"content_sha256" text,
	"record" jsonb NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "research_submission_materials_snapshot_key" UNIQUE("task_id","material_id"),
	CONSTRAINT "research_submission_materials_lineage_key" UNIQUE("task_id","lineage_root_material_id","material_version"),
	CONSTRAINT "research_submission_materials_client_key" UNIQUE("submission_id","client_ref"),
	CONSTRAINT "research_submission_materials_record_check" CHECK ((jsonb_typeof("research_submission_materials"."record") = 'object' AND "research_submission_materials"."record"->'source'->>'id' = "research_submission_materials"."source_id" AND "research_submission_materials"."record"->'source'->>'nature' = 'user_provided') IS TRUE),
	CONSTRAINT "research_submission_materials_shape_check" CHECK (((
      "research_submission_materials"."material_id" IS NULL AND "research_submission_materials"."material_version" IS NULL AND "research_submission_materials"."lineage_root_material_id" IS NULL AND "research_submission_materials"."content_sha256" IS NULL AND "research_submission_materials"."confirmed_by" IS NULL AND "research_submission_materials"."confirmed_at" IS NULL AND "research_submission_materials"."record"->'material' = 'null'::jsonb AND length("research_submission_materials"."record"->'source'->>'url') > 0
    ) OR (
      "research_submission_materials"."material_id" IS NOT NULL AND "research_submission_materials"."material_version" >= 1 AND "research_submission_materials"."lineage_root_material_id" IS NOT NULL AND "research_submission_materials"."content_sha256" ~ '^[a-f0-9]{64}$' AND
      "research_submission_materials"."record"->'material'->>'id' = "research_submission_materials"."material_id" AND ("research_submission_materials"."record"->'material'->>'version')::integer = "research_submission_materials"."material_version" AND "research_submission_materials"."record"->'material'->>'sourceId' = "research_submission_materials"."source_id" AND "research_submission_materials"."record"->'material'->>'kind' = 'pasted_text' AND length(btrim("research_submission_materials"."record"->'material'->>'content')) > 0 AND
      "research_submission_materials"."content_sha256" = encode(sha256(convert_to("research_submission_materials"."record"->'material'->>'content','UTF8')),'hex') AND "research_submission_materials"."record"->>'contentSha256' = "research_submission_materials"."content_sha256" AND "research_submission_materials"."record"->>'lineageRootMaterialId' = "research_submission_materials"."lineage_root_material_id"
    )) IS TRUE),
	CONSTRAINT "research_submission_materials_confirmation_check" CHECK (((
      "research_submission_materials"."confirmed_by" IS NULL AND "research_submission_materials"."confirmed_at" IS NULL AND ("research_submission_materials"."record"->'material' = 'null'::jsonb OR "research_submission_materials"."record"->'material'->'firstHandConfirmation' = 'null'::jsonb)
    ) OR (
      "research_submission_materials"."confirmed_by" IS NOT NULL AND "research_submission_materials"."confirmed_at" IS NOT NULL AND "research_submission_materials"."material_id" IS NOT NULL AND "research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'userId' = "research_submission_materials"."confirmed_by"::text AND ("research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'confirmedAt')::timestamptz = "research_submission_materials"."confirmed_at" AND ("research_submission_materials"."record"->'material'->'firstHandConfirmation'->>'materialVersion')::integer = "research_submission_materials"."material_version"
    )) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "research_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"base_result_id" text NOT NULL,
	"question_ids" jsonb NOT NULL,
	"gap_ids" jsonb NOT NULL,
	"official_site_grants" jsonb NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "research_submissions_scope_id_key" UNIQUE("task_id","attempt_id","id"),
	CONSTRAINT "research_submissions_authorization_key" UNIQUE("authorization_id"),
	CONSTRAINT "research_submissions_arrays_check" CHECK (jsonb_typeof("research_submissions"."question_ids") = 'array' AND jsonb_array_length("research_submissions"."question_ids") > 0 AND jsonb_typeof("research_submissions"."gap_ids") = 'array' AND jsonb_typeof("research_submissions"."official_site_grants") = 'array')
);
--> statement-breakpoint
ALTER TABLE "research_registries" ADD COLUMN "registry_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_submission_materials" ADD CONSTRAINT "research_submission_materials_confirmed_by_members_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_submission_materials" ADD CONSTRAINT "research_submission_materials_submission_fk" FOREIGN KEY ("task_id","attempt_id","submission_id") REFERENCES "public"."research_submissions"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_submissions" ADD CONSTRAINT "research_submissions_submitted_by_members_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_submissions" ADD CONSTRAINT "research_submissions_authorization_fk" FOREIGN KEY ("task_id","attempt_id","authorization_id") REFERENCES "public"."research_authorizations"("task_id","attempt_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_submissions" ADD CONSTRAINT "research_submissions_result_fk" FOREIGN KEY ("attempt_id","base_result_id") REFERENCES "public"."execution_steps"("attempt_id","result_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_submissions_task_idx" ON "research_submissions" USING btree ("task_id","submitted_at");--> statement-breakpoint
ALTER TABLE "research_registries" ADD CONSTRAINT "research_registries_revision_check" CHECK ("research_registries"."registry_revision" >= 0);
--> statement-breakpoint
-- These protections are deliberately versioned SQL, not represented by Drizzle snapshots.
CREATE FUNCTION research_submission_guard_v15() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth research_authorizations%ROWTYPE;
BEGIN
  PERFORM research_live_attempt_v14(NEW.task_id, NEW.attempt_id, false);
  SELECT * INTO auth FROM research_authorizations WHERE id=NEW.authorization_id FOR UPDATE;
  IF auth.mode IS DISTINCT FROM 'supplement' OR auth.consumed_at IS NOT NULL
      OR auth.base_result_id IS DISTINCT FROM NEW.base_result_id
      OR auth.authorized_by IS DISTINCT FROM NEW.submitted_by
      OR auth.scope->>'submissionId' IS DISTINCT FROM NEW.id::text
      OR auth.scope->'sources'->'officialSites' IS DISTINCT FROM NEW.official_site_grants
      OR NEW.question_ids IS DISTINCT FROM (SELECT jsonb_agg(q->'id' ORDER BY q->>'id') FROM jsonb_array_elements(auth.scope->'supplementScope'->'questions') q)
      OR NEW.gap_ids IS DISTINCT FROM coalesce((SELECT jsonb_agg(g->'id' ORDER BY g->>'id') FROM jsonb_array_elements(auth.scope->'supplementScope'->'gaps') g),'[]'::jsonb)
      OR NOT EXISTS (SELECT 1 FROM members m JOIN tasks t ON t.team_id=m.team_id
          WHERE t.id=NEW.task_id AND m.id=NEW.submitted_by AND m.status='active') THEN
    RAISE EXCEPTION 'submission must match its pending authorization and actor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER research_submissions_insert BEFORE INSERT ON research_submissions FOR EACH ROW EXECUTE FUNCTION research_submission_guard_v15();
--> statement-breakpoint
CREATE TRIGGER research_submissions_history BEFORE UPDATE OR DELETE ON research_submissions FOR EACH ROW EXECUTE FUNCTION research_history_immutable_v14();
--> statement-breakpoint
CREATE FUNCTION research_submission_material_guard_v15() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch research_submissions%ROWTYPE; expected_count integer; actual_count integer;
BEGIN
  PERFORM research_live_attempt_v14(NEW.task_id, NEW.attempt_id, false);
  SELECT * INTO batch FROM research_submissions WHERE id=NEW.submission_id;
  SELECT (scope->>'submissionRecordCount')::integer INTO expected_count FROM research_authorizations WHERE id=batch.authorization_id AND consumed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR (NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM batch.submitted_by) THEN
    RAISE EXCEPTION 'material must belong to an unconsumed user submission' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO actual_count FROM research_submission_materials WHERE submission_id=batch.id;
  IF expected_count IS NULL OR actual_count>=expected_count THEN
    RAISE EXCEPTION 'submission input set is frozen by its authorization' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER research_submission_materials_insert BEFORE INSERT ON research_submission_materials FOR EACH ROW EXECUTE FUNCTION research_submission_material_guard_v15();
--> statement-breakpoint
CREATE TRIGGER research_submission_materials_history BEFORE UPDATE OR DELETE ON research_submission_materials FOR EACH ROW EXECUTE FUNCTION research_history_immutable_v14();
--> statement-breakpoint
-- Deferred because authorization INSERT necessarily precedes submission/material INSERTs.
CREATE FUNCTION research_authorization_pair_guard_v15() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch research_submissions%ROWTYPE; actual_count integer; refs jsonb;
BEGIN
  -- Legacy scopes remain readable; new command scopes use the strict 1.0 envelope.
  IF NEW.scope->>'schemaVersion' IS DISTINCT FROM '1.0' THEN RETURN NEW; END IF;
  IF (NEW.scope->>'taskId'=NEW.task_id::text AND NEW.scope->>'attemptId'=NEW.attempt_id::text
      AND NEW.scope->>'mode'=NEW.mode AND NEW.scope->'selection'->>'selectionId'=NEW.selection_id::text) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope ownership mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.mode='initial' THEN
    IF NEW.scope->'baseResult' IS DISTINCT FROM 'null'::jsonb OR NEW.scope->'submissionId' IS DISTINCT FROM 'null'::jsonb
        OR NEW.scope->'materialRefs' IS DISTINCT FROM '[]'::jsonb OR NEW.scope->'sources'->'officialSites' IS DISTINCT FROM '[]'::jsonb
        OR NEW.scope->>'submissionRecordCount' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'initial authorization cannot inherit supplementary inputs' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO batch FROM research_submissions WHERE authorization_id=NEW.id;
  IF NOT FOUND OR batch.id::text IS DISTINCT FROM NEW.scope->>'submissionId' THEN
    RAISE EXCEPTION 'supplement authorization requires its atomic submission' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO actual_count FROM research_submission_materials WHERE submission_id=batch.id;
  IF actual_count IS DISTINCT FROM (NEW.scope->>'submissionRecordCount')::integer THEN
    RAISE EXCEPTION 'authorization must freeze all submission records, including link clues' USING ERRCODE='23514';
  END IF;
  refs=NEW.scope->'materialRefs';
  SELECT count(*) INTO actual_count FROM research_submission_materials WHERE submission_id=batch.id AND material_id IS NOT NULL;
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)<>actual_count OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(refs) r WHERE NOT EXISTS (
        SELECT 1 FROM research_submission_materials m WHERE m.submission_id=batch.id
          AND m.material_id=r->>'materialId' AND m.material_version=(r->>'version')::integer
          AND m.content_sha256=r->>'contentSha256')) OR EXISTS (
      SELECT 1 FROM research_submission_materials m WHERE m.submission_id=batch.id AND m.material_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'materialId'=m.material_id)) THEN
    RAISE EXCEPTION 'authorization material references must match committed records' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER research_authorizations_pair AFTER INSERT ON research_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION research_authorization_pair_guard_v15();
--> statement-breakpoint
-- Preserve v14 ownership/live-step checks while allowing a monotonic registry revision.
CREATE FUNCTION research_registry_guard_v15() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE auth research_authorizations%ROWTYPE; chosen_project jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'research registry history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['snapshot','updated_at','registry_revision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['snapshot','updated_at','registry_revision']) OR NEW.registry_revision<OLD.registry_revision
      OR (OLD.registry_revision>0 AND NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NEW.registry_revision<=OLD.registry_revision)) THEN
    RAISE EXCEPTION 'registry identity is immutable and revision must advance' USING ERRCODE='23514';
  END IF;
  PERFORM research_live_attempt_v14(NEW.task_id,NEW.attempt_id,true);
  SELECT * INTO auth FROM research_authorizations WHERE id=NEW.authorization_id;
  PERFORM 1 FROM execution_steps s WHERE s.id=NEW.step_id AND s.attempt_id=NEW.attempt_id
    AND s.status='running' AND auth.consumed_at IS NOT NULL AND auth.consumed_by_step_id=s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'registry requires its active research step' USING ERRCODE='23514'; END IF;
  SELECT project INTO chosen_project FROM project_selections WHERE id=auth.selection_id;
  IF NEW.snapshot->'selectedProject' IS DISTINCT FROM chosen_project THEN
    RAISE EXCEPTION 'registry selection mismatch' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER research_registries_history ON research_registries;
--> statement-breakpoint
CREATE TRIGGER research_registries_history BEFORE INSERT OR UPDATE OR DELETE ON research_registries FOR EACH ROW EXECUTE FUNCTION research_registry_guard_v15();
