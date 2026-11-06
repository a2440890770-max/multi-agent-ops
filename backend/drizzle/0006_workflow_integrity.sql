-- Preserve output links for content created before the workflow migration.
UPDATE execution_steps s SET output_content_id=c.id FROM task_contents c
WHERE s.attempt_id=c.origin_attempt_id AND s.role='content' AND s.ordinal=2
  AND s.status='completed' AND c.source_kind='agent' AND c.revision_round=0;

--> statement-breakpoint
ALTER TABLE "task_contents" ADD CONSTRAINT "task_contents_parent_fk" FOREIGN KEY ("task_id","parent_version_id") REFERENCES "public"."task_contents"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_review_fk" FOREIGN KEY ("id","current_review_cycle_id") REFERENCES "public"."review_cycles"("task_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION preserve_workflow_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow history is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_contents_immutable BEFORE UPDATE OR DELETE ON task_contents
FOR EACH ROW EXECUTE FUNCTION preserve_workflow_history();
--> statement-breakpoint
CREATE TRIGGER manual_decisions_immutable BEFORE UPDATE OR DELETE ON manual_decisions
FOR EACH ROW EXECUTE FUNCTION preserve_workflow_history();
--> statement-breakpoint
CREATE FUNCTION protect_review_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'terminal review is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_cycles_terminal_immutable BEFORE UPDATE OR DELETE ON review_cycles
FOR EACH ROW EXECUTE FUNCTION protect_review_terminal();
--> statement-breakpoint
CREATE FUNCTION protect_revision_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auto_revision_count < OLD.auto_revision_count THEN
    RAISE EXCEPTION 'automatic revision budget cannot be reset';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_attempts_budget_monotonic BEFORE UPDATE ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION protect_revision_budget();
