CREATE TABLE "settings" (
	"user_id" text NOT NULL,
	"tab" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_user_id_tab_pk" PRIMARY KEY("user_id","tab")
);
