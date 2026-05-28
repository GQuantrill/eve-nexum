#!/usr/bin/env bash
#
# Daily Postgres backup for the Nexum docker-compose deployment.
#
# Dumps the database via `docker compose exec`, gzips the output, writes it
# atomically into BACKUP_DIR, and keeps only the most recent KEEP files.
# Designed to be safe under cron: no TTY, hard fail on errors, log to stdout.
#
# Suggested cron entry (run as the user that owns the compose project):
#
#   0 5 * * *  /opt/eve-nexum/scripts/backup-db.sh >> /var/log/nexum-backup.log 2>&1
#
# All paths are configurable via env vars (defaults shown):
#
#   NEXUM_PROJECT_DIR=/opt/eve-nexum     # docker-compose project root
#   NEXUM_BACKUP_DIR=/var/backups/nexum  # where the .sql.gz files land
#   NEXUM_KEEP=7                         # number of dumps to retain
#
# Restoring from a dump: gunzip -c nexum-YYYY-MM-DD.sql.gz |
#                          docker compose exec -T postgres psql -U <PG_USER> -d <PG_DB>
#

set -euo pipefail

PROJECT_DIR="${NEXUM_PROJECT_DIR:-/opt/eve-nexum}"
BACKUP_DIR="${NEXUM_BACKUP_DIR:-/var/backups/nexum}"
KEEP="${NEXUM_KEEP:-7}"

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

# Read PG_USER / PG_DB straight from the deployed .env so this script stays in
# sync with whatever the running stack is using.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${PG_USER:?PG_USER not set in .env}"
: "${PG_DB:?PG_DB not set in .env}"

mkdir -p "$BACKUP_DIR"

# ── Dump ──────────────────────────────────────────────────────────────────────
STAMP="$(date +%Y-%m-%d)"
TARGET="$BACKUP_DIR/nexum-$STAMP.sql.gz"
TEMP="$TARGET.tmp"

log "dumping $PG_DB -> $TARGET"

# -T disables a TTY (cron has no terminal); --clean / --if-exists makes the
# dump restorable on top of an existing database without manual cleanup;
# --no-owner / --no-privileges keeps it portable across PG roles. We pipe
# through gzip on the host, write to a .tmp file, and rename only on success
# so a partial dump can never overwrite a previous good one.
if docker compose exec -T postgres pg_dump \
      --username="$PG_USER" \
      --dbname="$PG_DB" \
      --no-owner --no-privileges \
      --clean --if-exists \
   | gzip -9 > "$TEMP"; then
  mv "$TEMP" "$TARGET"
  log "OK ($(du -h "$TARGET" | cut -f1)): $TARGET"
else
  rc=$?
  rm -f "$TEMP"
  log "ERROR: pg_dump failed (exit $rc)" >&2
  exit "$rc"
fi

# ── Prune old backups ─────────────────────────────────────────────────────────
# Keep only the most recent $KEEP files matching the strict naming pattern.
# Count-based rather than mtime-based, and constrained to our own filename
# pattern so nothing else in BACKUP_DIR could be touched even by accident.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/nexum-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
if [ "${#OLD[@]}" -gt 0 ]; then
  log "pruning ${#OLD[@]} old backup(s) (keeping $KEEP):"
  for f in "${OLD[@]}"; do
    log "  removing $f"
    rm -f -- "$f"
  done
else
  log "no old backups to prune (keeping $KEEP)"
fi
