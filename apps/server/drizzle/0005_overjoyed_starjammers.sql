CREATE TABLE "feed_fetch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"response_url" text,
	"entry_count" integer,
	"error_code" text,
	"error_summary" text
);
--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "next_fetch_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_fetch_attempts" ADD CONSTRAINT "feed_fetch_attempts_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_fetch_attempts_feed_finished_idx" ON "feed_fetch_attempts" USING btree ("feed_id","finished_at");
