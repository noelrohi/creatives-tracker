-- One-off production baseline migration for legacy Adsolute databases.
--
-- Purpose:
-- - move legacy prod from pre-auth, pre-org schema to the current app shape
-- - preserve existing domain data
-- - seed a single organization for all existing rows
-- - create Drizzle migration tracking so future schema changes can use db:migrate:prod
--
-- Important:
-- - review on a staging clone first
-- - take a production backup/snapshot before running
-- - deploy the current application code before applying this SQL
-- - this file is intended for the specific legacy prod state inspected on 2026-03-26
--
-- Optional bootstrap behavior:
-- - if you already know the email of the first production admin, replace
--   __BOOTSTRAP_USER_EMAIL__ below before running
-- - if not, leave it untouched; the migration will still complete
-- - after the first real user signs up, rerun only the "bootstrap member" block
--
-- Assumptions verified from prod before drafting:
-- - legacy domain account table is still named "account"
-- - "ad_account" does not yet exist
-- - auth/org/api_key tables do not exist
-- - domain tables do not yet have organization_id
-- - ad_creative.asset_url and ad_creative.format already exist and are populated

BEGIN;

-- 1. Rename legacy domain account table so Better Auth can own "account".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'account'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ad_account'
  ) THEN
    EXECUTE 'ALTER TABLE "account" RENAME TO "ad_account"';
  END IF;
END $$;

-- 2. Better Auth tables.
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

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
);

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
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("user_id");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("user_id");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

-- 3. Organization tables.
CREATE TABLE IF NOT EXISTS "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "metadata" text
);

CREATE TABLE IF NOT EXISTS "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_uidx" ON "organization" ("slug");
CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member" ("organization_id");
CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member" ("user_id");
CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation" ("organization_id");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email");

-- 4. Domain organization_id columns.
ALTER TABLE "ad_account" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "campaign" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "ad_set" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "ad" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "ad_creative" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "landing_page" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "landing_page_version" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "tag" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "entity_tag" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "performance_log" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "ab_test" ADD COLUMN IF NOT EXISTS "organization_id" text;
ALTER TABLE "ab_test_variant" ADD COLUMN IF NOT EXISTS "organization_id" text;

CREATE INDEX IF NOT EXISTS "ad_account_organization_id_idx" ON "ad_account" ("organization_id");
CREATE INDEX IF NOT EXISTS "campaign_organization_id_idx" ON "campaign" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_set_organization_id_idx" ON "ad_set" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_organization_id_idx" ON "ad" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_creative_organization_id_idx" ON "ad_creative" ("organization_id");
CREATE INDEX IF NOT EXISTS "landing_page_organization_id_idx" ON "landing_page" ("organization_id");
CREATE INDEX IF NOT EXISTS "lp_version_organization_id_idx" ON "landing_page_version" ("organization_id");
CREATE INDEX IF NOT EXISTS "tag_organization_id_idx" ON "tag" ("organization_id");
CREATE INDEX IF NOT EXISTS "entity_tag_organization_id_idx" ON "entity_tag" ("organization_id");
CREATE INDEX IF NOT EXISTS "performance_log_organization_id_idx" ON "performance_log" ("organization_id");
CREATE INDEX IF NOT EXISTS "ab_test_organization_id_idx" ON "ab_test" ("organization_id");
CREATE INDEX IF NOT EXISTS "ab_test_variant_organization_id_idx" ON "ab_test_variant" ("organization_id");

ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_name_unique";
ALTER TABLE "tag" DROP CONSTRAINT IF EXISTS "tag_name_org_unique";
ALTER TABLE "tag" ADD CONSTRAINT "tag_name_org_unique" UNIQUE ("name", "organization_id");

-- 5. API key table.
CREATE TABLE IF NOT EXISTS "api_key" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "secret_hash" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "scopes" text[],
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_key_prefix_uidx" ON "api_key" ("prefix");
CREATE INDEX IF NOT EXISTS "api_key_organization_id_idx" ON "api_key" ("organization_id");
CREATE INDEX IF NOT EXISTS "api_key_created_by_user_id_idx" ON "api_key" ("created_by_user_id");

-- 6. Seed one organization for all existing legacy data.
INSERT INTO "organization" ("id", "name", "slug", "created_at", "metadata")
VALUES (
  'org_prod_legacy',
  'Legacy Production',
  'legacy-production',
  now(),
  '{"source":"baseline_auth_org","createdFor":"legacy-prod"}'
)
ON CONFLICT ("id") DO NOTHING;

UPDATE "ad_account" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "campaign" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "ad_set" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "ad" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "ad_creative" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "landing_page" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "landing_page_version" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "tag" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "entity_tag" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "performance_log" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "ab_test" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;
UPDATE "ab_test_variant" SET "organization_id" = 'org_prod_legacy' WHERE "organization_id" IS NULL;

-- 7. Optional bootstrap membership.
-- Replace __BOOTSTRAP_USER_EMAIL__ before running if you already know the admin user.
DO $$
DECLARE
  bootstrap_email text := nullif('__BOOTSTRAP_USER_EMAIL__', '__BOOTSTRAP_USER_EMAIL__');
  bootstrap_user_id text;
BEGIN
  IF bootstrap_email IS NULL THEN
    RETURN;
  END IF;

  SELECT "id"
  INTO bootstrap_user_id
  FROM "user"
  WHERE "email" = bootstrap_email
  LIMIT 1;

  IF bootstrap_user_id IS NULL THEN
    RAISE NOTICE 'Bootstrap email % not found in user table yet; rerun this block after the first admin signs up.', bootstrap_email;
    RETURN;
  END IF;

  INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
  VALUES (
    'member_prod_legacy_' || substr(md5(bootstrap_user_id), 1, 16),
    'org_prod_legacy',
    bootstrap_user_id,
    'owner',
    now()
  )
  ON CONFLICT ("id") DO NOTHING;

  UPDATE "session"
  SET "active_organization_id" = 'org_prod_legacy'
  WHERE "user_id" = bootstrap_user_id;
END $$;

-- 8. Establish Drizzle baseline tracking.
-- Drizzle for PostgreSQL stores migration state in drizzle.__drizzle_migrations.
-- It only checks the latest created_at value to decide what still needs to run.
CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  "id" serial PRIMARY KEY,
  "hash" text NOT NULL,
  "created_at" numeric
);

-- 1774665600000 is the current max "when" value in drizzle/meta/_journal.json.
-- This marks all existing repo migrations as already accounted for in prod.
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT 'prod-baseline-manual-auth-org', 1774665600000
WHERE NOT EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations"
);

COMMIT;

-- Post-run verification queries:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
--   AND table_name IN ('ad_account','user','session','account','verification','organization','member','invitation','api_key');
-- SELECT count(*) FROM "drizzle"."__drizzle_migrations";
-- SELECT count(*) FROM "ad_creative" WHERE organization_id IS NULL;
-- SELECT count(*) FROM "ad_account" WHERE organization_id IS NULL;
