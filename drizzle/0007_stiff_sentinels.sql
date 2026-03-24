CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"meta_account_id" text NOT NULL,
	"meta_access_token" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_meta_account_id_unique" UNIQUE("meta_account_id")
);
--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "ad" ADD CONSTRAINT "ad_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;