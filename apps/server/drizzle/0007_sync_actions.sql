CREATE TABLE "sync_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"model" text NOT NULL,
	"model_id" text,
	"action" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_floors" (
	"user_id" text PRIMARY KEY NOT NULL,
	"floor_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sync_actions_user_id_id_idx" ON "sync_actions" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "sync_actions_created_at_idx" ON "sync_actions" USING btree ("created_at");