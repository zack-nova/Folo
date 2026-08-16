CREATE TABLE "collections" (
	"user_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "collections_user_id_entry_id_pk" PRIMARY KEY("user_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"guid" text NOT NULL,
	"title" text,
	"description" text,
	"content" text,
	"url" text,
	"author" text,
	"author_url" text,
	"author_avatar" text,
	"language" text,
	"categories" jsonb,
	"attachments" jsonb,
	"media" jsonb,
	"extra" jsonb,
	"inserted_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"description" text,
	"site_url" text,
	"image" text,
	"owner_user_id" text,
	"error_at" timestamp with time zone,
	"error_message" text,
	"etag" text,
	"last_modified" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "read_states" (
	"user_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "read_states_user_id_entry_id_pk" PRIMARY KEY("user_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" text NOT NULL,
	"feed_id" text NOT NULL,
	"view" integer NOT NULL,
	"category" text,
	"title" text,
	"is_private" boolean NOT NULL,
	"hide_from_timeline" boolean,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscriptions_user_id_feed_id_pk" PRIMARY KEY("user_id","feed_id")
);
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_feed_guid_unique" ON "entries" USING btree ("feed_id","guid");--> statement-breakpoint
CREATE INDEX "entries_feed_published_idx" ON "entries" USING btree ("feed_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feeds_url_unique" ON "feeds" USING btree ("url");--> statement-breakpoint
CREATE INDEX "subscriptions_user_view_idx" ON "subscriptions" USING btree ("user_id","view");