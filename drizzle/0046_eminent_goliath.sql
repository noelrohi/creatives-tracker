CREATE TABLE "studio_suggestion_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'triggered' NOT NULL,
	"error_summary" text,
	"card_count" integer,
	"trigger_run_id" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_suggestion_run" ADD CONSTRAINT "studio_suggestion_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_suggestion_run_org_created_at_idx" ON "studio_suggestion_run" USING btree ("organization_id","created_at");