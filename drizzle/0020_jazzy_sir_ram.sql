CREATE TABLE "account_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"org_sync_run_id" text,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"breakdowns_requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"breakdowns_completed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_phase" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"result" text,
	"rows_synced" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"inngest_function_id" text,
	"inngest_run_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "org_sync_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"result" text,
	"meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "account_sync_run" ADD CONSTRAINT "account_sync_run_org_sync_run_id_org_sync_run_id_fk" FOREIGN KEY ("org_sync_run_id") REFERENCES "public"."org_sync_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sync_run" ADD CONSTRAINT "account_sync_run_account_id_ad_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_sync_run_org_sync_run_id_idx" ON "account_sync_run" USING btree ("org_sync_run_id");--> statement-breakpoint
CREATE INDEX "account_sync_run_organization_id_idx" ON "account_sync_run" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_sync_run_account_id_idx" ON "account_sync_run" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_sync_run_requested_at_idx" ON "account_sync_run" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "org_sync_run_organization_id_idx" ON "org_sync_run" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_sync_run_requested_at_idx" ON "org_sync_run" USING btree ("requested_at");