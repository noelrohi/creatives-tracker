#!/bin/bash
set -eo pipefail

ENV_FILE="$(dirname "$0")/../.env"

PROD_URL="$(grep '^PRODUCTION_DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)"
LOCAL_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)"

if [ -z "$PROD_URL" ] || [ -z "$LOCAL_URL" ]; then
  echo "Error: PRODUCTION_DATABASE_URL and DATABASE_URL must be set in .env"
  exit 1
fi

DUMP_FILE="$(mktemp /tmp/adsolute-prod-dump.XXXXXX)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "==> Dumping production database from Neon..."
/opt/homebrew/opt/postgresql@17/bin/pg_dump "$PROD_URL" \
  --no-owner \
  --no-privileges \
  --no-comments \
  --schema=public \
  --extension=pg_trgm \
  --format=custom \
  > "$DUMP_FILE"

echo "==> Dropping all tables in local database..."
psql "$LOCAL_URL" -X --set=ON_ERROR_STOP=1 -c "
  DROP SCHEMA IF EXISTS public CASCADE;
"

# The archive creates public and pg_trgm before restoring tables and indexes.
# Schema selection alone does not include the extension's operator classes.
echo "==> Restoring into local database..."
/opt/homebrew/opt/postgresql@17/bin/pg_restore "$DUMP_FILE" \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --dbname="$LOCAL_URL"

echo "==> Done! Local database is now synced with production."
