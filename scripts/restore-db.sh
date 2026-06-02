#!/usr/bin/env bash
#
# Restore a Nexum Postgres backup produced by backup-db.sh, for the
# docker-compose deployment.
#
# Usage:
#   scripts/restore-db.sh [BACKUP_FILE]
#     - with a path: restores that .sql.gz
#     - with no arg: restores the most recent backup in NEXUM_BACKUP_DIR
#
# DESTRUCTIVE: the dumps are written with --clean --if-exists, so a restore
# drops and recreates the dumped objects, replacing current data. The server
# container is stopped for the duration so it can't write mid-restore, then
# started again.
#
# All paths are configurable via env vars (defaults shown):
#
#   NEXUM_PROJECT_DIR=/opt/eve-nexum     # docker-compose project root
#   NEXUM_BACKUP_DIR=/var/backups/nexum  # where the .sql.gz files live
#   NEXUM_FORCE=0                        # set to 1 to skip the confirm prompt
#
set -euo pipefail

PROJECT_DIR="${NEXUM_PROJECT_DIR:-/opt/eve-nexum}"
BACKUP_DIR="${NEXUM_BACKUP_DIR:-/var/backups/nexum}"
FORCE="${NEXUM_FORCE:-0}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# ── Pre-flight ────────────────────────────────────────────────────────────────
if [ ! -d "$PROJECT_DIR" ]; then
  log "ERROR: project dir not found: $PROJECT_DIR" >&2
  exit 1
fi
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  log "ERROR: .env not found in $PROJECT_DIR" >&2
  exit 1
fi

# Read PG_USER / PG_DB from the deployed .env so this stays in sync with the
# running stack (same as backup-db.sh).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${PG_USER:?PG_USER not set in .env}"
: "${PG_DB:?PG_DB not set in .env}"

# ── Resolve the backup file ───────────────────────────────────────────────────
FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -1t "$BACKUP_DIR"/nexum-*.sql.gz 2>/dev/null | head -n1 || true)"
  if [ -z "$FILE" ]; then
    log "ERROR: no backups found in $BACKUP_DIR (and no file given)" >&2
    exit 1
  fi
  log "no file given; using most recent: $FILE"
fi
if [ ! -f "$FILE" ]; then
  log "ERROR: backup file not found: $FILE" >&2
  exit 1
fi

# ── Confirm (destructive) ─────────────────────────────────────────────────────
log "About to restore '$FILE' into database '$PG_DB' on this deployment."
log "This OVERWRITES current data (drops & recreates the dumped objects)."
if [ "$FORCE" != "1" ]; then
  read -r -p "Type the database name ('$PG_DB') to confirm: " ans
  if [ "$ans" != "$PG_DB" ]; then
    log "aborted"
    exit 1
  fi
fi

# ── Restore ───────────────────────────────────────────────────────────────────
# Stop the server so it can't read/write a half-applied schema during the
# restore; bring it back afterwards (even if the restore fails). ON_ERROR_STOP
# makes psql abort on the first error rather than silently half-applying.
log "stopping server container"
docker compose stop server || true

log "restoring (can take a while if the dump includes the SDE tables)..."
if gunzip -c "$FILE" | docker compose exec -T postgres psql \
      --username="$PG_USER" \
      --dbname="$PG_DB" \
      --set ON_ERROR_STOP=1 \
      --quiet; then
  log "restore OK"
else
  rc=$?
  log "ERROR: restore failed (exit $rc)" >&2
  log "starting server container again"
  docker compose start server || true
  exit "$rc"
fi

log "starting server container"
docker compose start server
log "done"
