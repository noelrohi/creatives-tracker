CREATE TABLE "studio_brand_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"brand_name" text NOT NULL,
	"product_description" text NOT NULL,
	"offer" text,
	"product_image_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_brand_profile_org_uidx" ON "studio_brand_profile" USING btree ("organization_id");