CREATE TYPE "public"."plan_rule_source" AS ENUM('feedback', 'manual');--> statement-breakpoint
CREATE TYPE "public"."test_plan_hook_rating" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TABLE "plan_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"text" text NOT NULL,
	"source" "plan_rule_source" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"attribution_name" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"concept_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"text" text NOT NULL,
	"promoted_rule_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_hook_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"concept_id" text NOT NULL,
	"hook" text NOT NULL,
	"rating" "test_plan_hook_rating" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_plan_concept" ADD COLUMN "hook_copy" jsonb;--> statement-breakpoint
ALTER TABLE "plan_rule" ADD CONSTRAINT "plan_rule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_comment" ADD CONSTRAINT "test_plan_comment_concept_id_test_plan_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."test_plan_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_comment" ADD CONSTRAINT "test_plan_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_comment" ADD CONSTRAINT "test_plan_comment_promoted_rule_id_plan_rule_id_fk" FOREIGN KEY ("promoted_rule_id") REFERENCES "public"."plan_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_hook_feedback" ADD CONSTRAINT "test_plan_hook_feedback_concept_id_test_plan_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."test_plan_concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_rule_organization_id_idx" ON "plan_rule" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "test_plan_comment_organization_id_idx" ON "test_plan_comment" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_plan_hook_feedback_concept_id_hook_uidx" ON "test_plan_hook_feedback" USING btree ("concept_id","hook");--> statement-breakpoint
CREATE INDEX "test_plan_hook_feedback_organization_id_idx" ON "test_plan_hook_feedback" USING btree ("organization_id");