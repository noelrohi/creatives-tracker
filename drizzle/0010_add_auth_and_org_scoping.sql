-- Step 1: Rename domain account table to ad_account FIRST
-- (Better Auth needs to create its own "account" table)
ALTER TABLE "account" RENAME TO "ad_account";--> statement-breakpoint

-- Step 2: Better Auth tables
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" text
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text UNIQUE,
  "logo" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" text
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  "team_id" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);--> statement-breakpoint

-- Step 3: Add organization_id to all domain tables (nullable for existing data)
ALTER TABLE "ad_account" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "campaign" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ad_set" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ad" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ad_creative" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "landing_page" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "landing_page_version" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "tag" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "performance_log" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ab_test" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ab_test_variant" ADD COLUMN "organization_id" text;--> statement-breakpoint

-- Step 4: Indexes for organization_id
CREATE INDEX IF NOT EXISTS "ad_account_organization_id_idx" ON "ad_account" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_organization_id_idx" ON "campaign" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_set_organization_id_idx" ON "ad_set" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_organization_id_idx" ON "ad" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_creative_organization_id_idx" ON "ad_creative" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landing_page_organization_id_idx" ON "landing_page" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_version_organization_id_idx" ON "landing_page_version" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tag_organization_id_idx" ON "tag" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_tag_organization_id_idx" ON "entity_tag" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "performance_log_organization_id_idx" ON "performance_log" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ab_test_organization_id_idx" ON "ab_test" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ab_test_variant_organization_id_idx" ON "ab_test_variant" ("organization_id");--> statement-breakpoint

-- Step 5: Update tag unique constraint
ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_name_unique";--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_name_org_unique" UNIQUE ("name", "organization_id");
