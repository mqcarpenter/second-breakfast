#!/usr/bin/env bash
# Nightly backup: Postgres dump + media mirror to a SECOND disk.
# Keeps 7 daily and 4 weekly dumps. Run from cron or the systemd timer.
#
# Config comes from the environment (see backup.env.example):
#   DEPLOY_DIR    path to the deploy/ folder containing docker-compose.yml
#   BACKUP_MOUNT  mount point of the backup disk (must be a real mount)
#   MEDIA_DIR     media folder to mirror (same value as in deploy/.env)
set -euo pipefail

: "${DEPLOY_DIR:?set DEPLOY_DIR}"
: "${BACKUP_MOUNT:?set BACKUP_MOUNT}"
: "${MEDIA_DIR:?set MEDIA_DIR}"

# Refuse to run if the backup disk is not mounted, so we never fill the root disk.
if ! mountpoint -q "$BACKUP_MOUNT"; then
  echo "ERROR: $BACKUP_MOUNT is not mounted. Aborting." >&2
  exit 1
fi

DEST="$BACKUP_MOUNT/second-breakfast-backup"
DB_DIR="$DEST/db"
mkdir -p "$DB_DIR/daily" "$DB_DIR/weekly" "$DEST/media"

# Read only the non-secret database names from .env (never source the whole file).
envval() { grep -E "^$1=" "$DEPLOY_DIR/.env" | tail -n1 | cut -d= -f2-; }
PGUSER="$(envval POSTGRES_USER)"; PGUSER="${PGUSER:-journiv}"
PGDB="$(envval POSTGRES_DB)";     PGDB="${PGDB:-journiv_prod}"

STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$DB_DIR/.in-progress-$STAMP.dump"

echo "[$(date -Is)] dumping database $PGDB"
cd "$DEPLOY_DIR"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$TMP"
[ -s "$TMP" ] || { echo "ERROR: empty dump" >&2; rm -f "$TMP"; exit 1; }
mv "$TMP" "$DB_DIR/daily/db-$STAMP.dump"

# Sunday's dump also becomes the weekly copy.
if [ "$(date +%u)" = "7" ]; then
  cp "$DB_DIR/daily/db-$STAMP.dump" "$DB_DIR/weekly/db-$STAMP.dump"
fi

# Retention: 7 daily, 4 weekly.
ls -1t "$DB_DIR"/daily/db-*.dump  2>/dev/null | tail -n +8 | xargs -r rm -f --
ls -1t "$DB_DIR"/weekly/db-*.dump 2>/dev/null | tail -n +5 | xargs -r rm -f --

# Media mirror. -rt with a modify window works on NTFS/FAT/ext4 alike.
# No --delete: a file removed by mistake stays in the backup. Prune by hand when sure.
echo "[$(date -Is)] syncing media"
rsync -rt --partial --modify-window=2 "$MEDIA_DIR"/ "$DEST/media"/

echo "[$(date -Is)] backup finished"
