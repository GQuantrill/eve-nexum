#!/usr/bin/env bash
#
# Restore a Nexum Postgres backup produced by backup-db.sh, for the
# docker-compose deployment.
#
# Usage:
#   scripts/restore-db.sh [BACKUP_FILE]
#     - with a path: restores that .sql.gz
#     - with no arg: restores the most recent backup for this instance, from
#       NEXUM_BACKUP_DIR/<compose project>/ (where backup-db.sh writes).
#       Older backups sitting directly in NEXUM_BACKUP_DIR (from before it used
#       per-instance folders) are never picked automatically -- with several
#       instances there's no telling whose they are -- so pass one by path.
#
# DESTRUCTIVE: the dumps are written with --clean --if-exists, so a restore
# drops and recreates the dumped objects, replacing current data. The server
# container is stopped for the duration so it can't write mid-restore, then
# started again.
#
# All paths are configurable via env vars (defaults shown):
#
#   NEXUM_PROJECT_DIR=/opt/eve-nexum     # docker-compose project root
#   NEXUM_BACKUP_DIR=/var/backups/nexum  # backup root, as for backup-db.sh
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

# Read one key from ./.env (optional -- a deploy may keep its config in a
# secrets manager instead). We do NOT `source` the file — .env is a dotenv
# file, not a shell script, so `source` breaks on any line that isn't a clean
# shell assignment. Last assignment wins, surrounding quotes and a trailing CR
# trimmed. Empty when there's no .env or no such key.
read_env() {
  local val
  [ -f .env ] || return 0
  val="$(grep -E "^[[:space:]]*${1}=" .env | tail -n1)" || return 0
  val="${val#*=}"
  val="${val%$'\r'}"
  val="${val#"${val%%[![:space:]]*}"}"   # ltrim
  val="${val%"${val##*[![:space:]]}"}"   # rtrim
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

# Same project naming as backup-db.sh (and docker compose): COMPOSE_PROJECT_NAME
# from .env, else the directory name.
PROJ="$(read_env COMPOSE_PROJECT_NAME)"
if [ -z "$PROJ" ]; then
  PROJ="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
fi
export COMPOSE_PROJECT_NAME="$PROJ"

# Database and user: what the postgres container was started with, so this
# matches the running stack wherever its config lives.
# shellcheck disable=SC2016  # expanded inside the container, not here
PG_USER="$(docker compose exec -T postgres sh -c 'printf %s "$POSTGRES_USER"')"
# shellcheck disable=SC2016
PG_DB="$(docker compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"')"

: "${PG_USER:?could not read POSTGRES_USER from the postgres container (is the stack running?)}"
: "${PG_DB:?could not read POSTGRES_DB from the postgres container (is the stack running?)}"

# ── Resolve the backup file ───────────────────────────────────────────────────
FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -1t "$BACKUP_DIR/$PROJ"/nexum-*.sql.gz 2>/dev/null | head -n1 || true)"
  if [ -z "$FILE" ]; then
    log "ERROR: no backups found in $BACKUP_DIR/$PROJ (and no file given)" >&2
    exit 1
  fi
  log "no file given; using most recent: $FILE"
fi
if [ ! -f "$FILE" ]; then
  log "ERROR: backup file not found: $FILE" >&2
  exit 1
fi

# ── Confirm (destructive) ─────────────────────────────────────────────────────
log "About to restore '$FILE' into database '$PG_DB' on '$PROJ'."
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
