CREATE TABLE "ai_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"role" text NOT NULL,
	"message_parts" jsonb NOT NULL,
	"metadata" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_chat_sessions" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"candidate_count" integer,
	"selected_count" integer,
	"unevaluated_count" integer,
	"error_code" text,
	"error_summary" text,
	"usage" jsonb,
	"session_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"is_enabled" boolean NOT NULL,
	"schedule" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"run_count" integer NOT NULL,
	"last_result" text,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_chat_id_ai_chat_sessions_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."ai_chat_sessions"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_task_id_ai_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_messages_chat_idx" ON "ai_chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_chat_sessions_user_idx" ON "ai_chat_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_task_runs_scheduled_slot_unique" ON "ai_task_runs" USING btree ("task_id","scheduled_for") WHERE "ai_task_runs"."kind" = 'scheduled';--> statement-breakpoint
CREATE INDEX "ai_task_runs_queue_idx" ON "ai_task_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ai_task_runs_task_idx" ON "ai_task_runs" USING btree ("task_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "ai_tasks_user_idx" ON "ai_tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tasks_due_idx" ON "ai_tasks" USING btree ("is_enabled","next_run_at");