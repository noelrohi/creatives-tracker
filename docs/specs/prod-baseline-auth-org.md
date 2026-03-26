# Production Baseline: Auth, Orgs, API Keys

This document is the rollout companion for [baseline_auth_org.sql](/Users/rohi/sandbox/adsolute/scripts/prod/baseline_auth_org.sql).

## Why this exists

Production is not under Drizzle migration tracking yet and is still on the legacy pre-auth schema.

Observed production state on 2026-03-26:

- no `drizzle.__drizzle_migrations`
- no Better Auth tables: `user`, `session`, `account`, `verification`
- no org tables: `organization`, `member`, `invitation`
- no `api_key`
- legacy domain account table is still `account`
- `ad_creative.asset_url` and `ad_creative.format` already exist and are fully populated
- `157` creatives exist, with `0` missing `asset_url`
- `3` legacy account rows exist, with `0` Meta access tokens currently stored

Because of that, `bun run db:migrate:prod` is not safe to run directly against prod.

## What the one-off SQL does

The baseline SQL:

1. Renames legacy `account` to `ad_account`
2. Creates Better Auth tables
3. Creates org and invitation tables
4. Adds `organization_id` to the legacy domain tables
5. Seeds a single org, `org_prod_legacy`
6. Backfills all existing domain rows into that org
7. Creates `api_key`
8. Creates `drizzle.__drizzle_migrations` and inserts a manual baseline marker

It is written to be idempotent for the inspected prod state.

## Rollout order

1. Push and deploy the current app code.
2. Take a production snapshot/backup.
3. Run [baseline_auth_org.sql](/Users/rohi/sandbox/adsolute/scripts/prod/baseline_auth_org.sql) manually with `psql`.
4. Verify the schema and row backfill.
5. Sign up the first real admin user in production.
6. Rerun only the bootstrap-member block, or manually add that user as owner of `org_prod_legacy`.
7. Log in and confirm the user can switch into `Legacy Production`.
8. After this baseline is in place, use `bun run db:migrate:prod` only for future migrations.

## First admin attachment

If the first admin user does not exist yet when the baseline SQL runs:

- leave `__BOOTSTRAP_USER_EMAIL__` untouched
- let the migration complete
- once the admin signs up, rerun this block with their real email

```sql
DO $$
DECLARE
  bootstrap_email text := 'founder@example.com';
  bootstrap_user_id text;
BEGIN
  SELECT "id"
  INTO bootstrap_user_id
  FROM "user"
  WHERE "email" = bootstrap_email
  LIMIT 1;

  IF bootstrap_user_id IS NULL THEN
    RAISE EXCEPTION 'User % not found', bootstrap_email;
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
```

## Data hydration

No creative asset backfill is needed right now.

Verified in prod:

- `ad_creative.asset_url`: no missing values
- `ad_creative.format`: no missing values

Resync is also not useful yet because the legacy prod `account` data currently has `0` stored Meta access tokens.

## Suggested verification

After running the baseline SQL:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'ad_account',
    'user',
    'session',
    'account',
    'verification',
    'organization',
    'member',
    'invitation',
    'api_key'
  )
ORDER BY table_name;
```

```sql
SELECT count(*) FROM "drizzle"."__drizzle_migrations";
```

```sql
SELECT count(*) FROM "ad_creative" WHERE organization_id IS NULL;
```

```sql
SELECT count(*) FROM "ad_account" WHERE organization_id IS NULL;
```
