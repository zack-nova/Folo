CREATE TABLE "action_rules" (
	"user_id" text PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_configs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"key_hint" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_current_evaluations" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"selected_at" timestamp with time zone NOT NULL,
	"selection_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"importance_score" integer NOT NULL,
	"timeliness_score" integer NOT NULL,
	"relevance_score" integer NOT NULL,
	"overall_score" integer NOT NULL,
	"recommendation_reason" text NOT NULL,
	"primary_category" text NOT NULL,
	"secondary_category" text,
	"tags" jsonb NOT NULL,
	"processor_type" text NOT NULL,
	"processor_name" text NOT NULL,
	"processor_version" text NOT NULL,
	"score_formula_version" text NOT NULL,
	"profile_snapshot_id" text NOT NULL,
	"taxonomy_snapshot_id" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "entry_summaries" (
	"entry_id" text NOT NULL,
	"language" text NOT NULL,
	"target" text NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entry_summaries_entry_id_language_target_pk" PRIMARY KEY("entry_id","language","target")
);
--> statement-breakpoint
CREATE TABLE "entry_translations" (
	"entry_id" text NOT NULL,
	"language" text NOT NULL,
	"title" text,
	"description" text,
	"content" text,
	"readability_content" text,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entry_translations_entry_id_language_pk" PRIMARY KEY("entry_id","language")
);
--> statement-breakpoint
CREATE TABLE "processing_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error_summary" text,
	"execution_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"purpose" text NOT NULL,
	"processor_name" text NOT NULL,
	"processor_version" text NOT NULL,
	"score_formula_version" text NOT NULL,
	"profile_snapshot_id" text NOT NULL,
	"taxonomy_snapshot_id" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"priority" integer NOT NULL,
	"attempt_count" integer NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_summary" text,
	"idempotency_key" text NOT NULL,
	"force_rerun" boolean NOT NULL,
	"superseded_by_job_id" text
);
--> statement-breakpoint
CREATE TABLE "processing_profile_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_taxonomy_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_current_evaluations" ADD CONSTRAINT "entry_current_evaluations_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_current_evaluations" ADD CONSTRAINT "entry_current_evaluations_evaluation_id_entry_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."entry_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_evaluations" ADD CONSTRAINT "entry_evaluations_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_evaluations" ADD CONSTRAINT "entry_evaluations_profile_snapshot_id_processing_profile_snapshots_id_fk" FOREIGN KEY ("profile_snapshot_id") REFERENCES "public"."processing_profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_evaluations" ADD CONSTRAINT "entry_evaluations_taxonomy_snapshot_id_processing_taxonomy_snapshots_id_fk" FOREIGN KEY ("taxonomy_snapshot_id") REFERENCES "public"."processing_taxonomy_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_summaries" ADD CONSTRAINT "entry_summaries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_translations" ADD CONSTRAINT "entry_translations_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_attempts" ADD CONSTRAINT "processing_attempts_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_profile_snapshot_id_processing_profile_snapshots_id_fk" FOREIGN KEY ("profile_snapshot_id") REFERENCES "public"."processing_profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_taxonomy_snapshot_id_processing_taxonomy_snapshots_id_fk" FOREIGN KEY ("taxonomy_snapshot_id") REFERENCES "public"."processing_taxonomy_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_evaluations_history_idx" ON "entry_evaluations" USING btree ("entry_id","processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_attempt_job_number_unique" ON "processing_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "processing_jobs_queue_idx" ON "processing_jobs" USING btree ("status","next_retry_at","priority");--> statement-breakpoint
CREATE INDEX "processing_jobs_entry_idx" ON "processing_jobs" USING btree ("user_id","entry_id","queued_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_idempotency_idx" ON "processing_jobs" USING btree ("idempotency_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_profile_name_version_unique" ON "processing_profile_snapshots" USING btree ("user_id","name","version");--> statement-breakpoint
CREATE INDEX "processing_profile_latest_idx" ON "processing_profile_snapshots" USING btree ("user_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_taxonomy_name_version_unique" ON "processing_taxonomy_snapshots" USING btree ("user_id","name","version");--> statement-breakpoint
CREATE INDEX "processing_taxonomy_latest_idx" ON "processing_taxonomy_snapshots" USING btree ("user_id","name","version");