#!/usr/bin/env bash
# Restore the newest daily dump into a THROWAWAY database and count rows.
# Proves the backup is usable without touching the live database.
# Needs the same env as backup.sh (DEPLOY_DIR, BACKUP_MOUNT).
set -euo pipefail
: "${DEPLOY_DIR:?}"; : "${BACKUP_MOUNT:?}"
mountpoint -q "$BACKUP_MOUNT" || { echo "ERROR: $BACKUP_MOUNT not mounted" >&2; exit 1; }

DUMP="$(ls -1t "$BACKUP_MOUNT"/second-breakfast-backup/db/daily/db-*.dump | head -n1)"
echo "Testing restore of: $DUMP"

envval() { grep -E "^$1=" "$DEPLOY_DIR/.env" | tail -n1 | cut -d= -f2-; }
PGUSER="$(envval POSTGRES_USER)"; PGUSER="${PGUSER:-journiv}"
cd "$DEPLOY_DIR"

docker compose exec -T postgres psql -U "$PGUSER" -d postgres -c 'DROP DATABASE IF EXISTS restore_test;' -c 'CREATE DATABASE restore_test;'
docker compose exec -T postgres pg_restore -U "$PGUSER" -d restore_test --no-owner < "$DUMP"
docker compose exec -T postgres psql -U "$PGUSER" -d restore_test -c "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public';"
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -c 'DROP DATABASE restore_test;'
echo "Restore test OK."
