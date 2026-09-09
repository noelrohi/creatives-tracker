CREATE TABLE "studio_context_document" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text NOT NULL,
	"source_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_context_image" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"image_url" text NOT NULL,
	"source_filename" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_context_section" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "kind" text DEFAULT 'generation' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "source_competitor_ad_id" text;--> statement-breakpoint
ALTER TABLE "studio_generation" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "studio_variant" ADD COLUMN "attempts" jsonb;--> statement-breakpoint
ALTER TABLE "studio_context_section" ADD CONSTRAINT "studio_context_section_document_id_studio_context_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."studio_context_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_context_document_org_file_uidx" ON "studio_context_document" USING btree ("organization_id","source_filename");--> statement-breakpoint
CREATE INDEX "studio_context_document_org_idx" ON "studio_context_document" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_context_image_org_file_uidx" ON "studio_context_image" USING btree ("organization_id","source_filename");--> statement-breakpoint
CREATE INDEX "studio_context_image_org_idx" ON "studio_context_image" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_context_section_document_idx" ON "studio_context_section" USING btree ("document_id","ordinal");