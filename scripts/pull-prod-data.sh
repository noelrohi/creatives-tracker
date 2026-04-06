#!/bin/bash
set -eo pipefail

ENV_FILE="$(dirname "$0")/../.env"

PROD_URL="$(grep '^PRODUCTION_DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)"
LOCAL_URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d'=' -f2-)"

if [ -z "$PROD_URL" ] || [ -z "$LOCAL_URL" ]; then
  echo "Error: PRODUCTION_DATABASE_URL and DATABASE_URL must be set in .env"
  exit 1
fi

DUMP_FILE="/tmp/adsolute-prod-dump.sql"

echo "==> Dumping production database from Neon..."
/opt/homebrew/opt/postgresql@17/bin/pg_dump "$PROD_URL" \
  --no-owner \
  --no-privileges \
  --no-comments \
  --schema=public \
  --format=custom \
  > "$DUMP_FILE"

echo "==> Dropping all tables in local database..."
psql "$LOCAL_URL" -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
"

echo "==> Restoring into local database..."
/opt/homebrew/opt/postgresql@17/bin/pg_restore "$DUMP_FILE" \
  --no-owner \
  --no-privileges \
  --dbname="$LOCAL_URL"

rm -f "$DUMP_FILE"

echo "==> Done! Local database is now synced with production."
