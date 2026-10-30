CREATE TABLE "clarification_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"answered_by" uuid NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarification_answers_attempt_question_key" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "clarification_answers_text_check" CHECK (char_length("clarification_answers"."answer") BETWEEN 1 AND 4000 AND char_length(btrim("clarification_answers"."answer")) > 0 AND char_length("clarification_answers"."question") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_attempt_fk" FOREIGN KEY ("task_id","attempt_id") REFERENCES "public"."execution_attempts"("task_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_answers" ADD CONSTRAINT "clarification_answers_member_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarification_answers_task_idx" ON "clarification_answers" USING btree ("task_id");