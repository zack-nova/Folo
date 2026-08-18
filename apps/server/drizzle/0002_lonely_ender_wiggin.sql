CREATE TABLE "entry_readability" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_ownership" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "instance_ownership_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "list_subscriptions" (
	"user_id" text NOT NULL,
	"list_id" text NOT NULL,
	"view" integer NOT NULL,
	"category" text,
	"title" text,
	"is_private" boolean NOT NULL,
	"hide_from_timeline" boolean,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "list_subscriptions_user_id_list_id_pk" PRIMARY KEY("user_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_ids" text[] NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image" text,
	"view" integer NOT NULL,
	"fee" integer NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entry_readability" ADD CONSTRAINT "entry_readability_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_subscriptions" ADD CONSTRAINT "list_subscriptions_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "list_subscriptions_user_view_idx" ON "list_subscriptions" USING btree ("user_id","view");--> statement-breakpoint
CREATE INDEX "lists_owner_idx" ON "lists" USING btree ("owner_user_id");