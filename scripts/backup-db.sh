#!/usr/bin/env bash
#
# Daily Postgres backup for one or more Nexum docker-compose deployments.
#
# For each instance: dumps the database via `docker compose exec`, gzips the
# output, writes it atomically into BACKUP_DIR/<compose project>/, and keeps
# only the most recent KEEP files there. One instance failing doesn't stop the
# others; the script exits non-zero at the end if any failed.
# Designed to be safe under cron: no TTY, hard fail on errors, log to stdout.
#
# Usage:
#
#   backup-db.sh [PROJECT_DIR ...]
#
# Instances are taken from, in order of precedence:
#   1. the arguments                    backup-db.sh /opt/eve-nexum /opt/nexum-gsf
#   2. NEXUM_PROJECT_DIRS (space-separated list)
#   3. NEXUM_PROJECT_DIR  (a single instance; default /opt/eve-nexum)
#
# Suggested cron entry (run as the user that owns the compose projects):
#
#   0 5 * * *  /opt/eve-nexum/scripts/backup-db.sh /opt/eve-nexum /opt/nexum-gsf /opt/nexum-kf >> /var/log/nexum-backup.log 2>&1
#
# Other settings (defaults shown):
#
#   NEXUM_BACKUP_DIR=/var/backups/nexum  # each instance gets a subfolder here
#   NEXUM_KEEP=7                         # number of dumps to retain per instance
#
# Each instance's subfolder is its compose project name (COMPOSE_PROJECT_NAME
# from its .env, else the directory name -- the same name docker compose uses
# to prefix its containers), so instances can never prune each other's dumps.
#
# Restoring: see scripts/restore-db.sh, or by hand:
#   gunzip -c nexum-YYYY-MM-DD.sql.gz |
#     docker compose exec -T postgres psql -U <PG_USER> -d <PG_DB>
#

set -euo pipefail

BACKUP_ROOT="${NEXUM_BACKUP_DIR:-/var/backups/nexum}"
KEEP="${NEXUM_KEEP:-7}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ "$#" -gt 0 ]; then
  PROJECT_DIRS=("$@")
elif [ -n "${NEXUM_PROJECT_DIRS:-}" ]; then
  read -r -a PROJECT_DIRS <<< "$NEXUM_PROJECT_DIRS"
else
  PROJECT_DIRS=("${NEXUM_PROJECT_DIR:-/opt/eve-nexum}")
fi

# Read one key from ./.env. We do NOT `source` the file: .env is a dotenv file
# (parsed by the app via the `dotenv` library), not a shell script, so `source`
# chokes on any line that isn't a clean shell assignment (e.g. an uncommented
# `SDE_CHECK_UTC=11:30  # comment`). Last assignment wins; surrounding quotes
# and a trailing CR are trimmed. Empty when there's no .env or no such key.
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

# Back up one instance. Runs in a subshell (see the loop below) so its cd and
# COMPOSE_PROJECT_NAME can't leak into the next instance. It's called from an
# `if`, where bash suspends `set -e`, so every step that can fail returns
# explicitly.
backup_instance() {
  local project_dir="$1"

  if [ ! -d "$project_dir" ]; then
    log "ERROR: project dir not found: $project_dir" >&2
    return 1
  fi
  cd "$project_dir" || return 1

  # Target the right stack: compose names a project from COMPOSE_PROJECT_NAME
  # when the deploy sets one, else from the directory name (lowercased, and
  # anything but letters, digits, - and _ dropped).
  local proj
  proj="$(read_env COMPOSE_PROJECT_NAME)"
  if [ -z "$proj" ]; then
    proj="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  fi
  export COMPOSE_PROJECT_NAME="$proj"

  local dir="$BACKUP_ROOT/$proj"
  mkdir -p "$dir" || return 1

  # ── Dump ────────────────────────────────────────────────────────────────────
  local target temp
  target="$dir/nexum-$(date +%Y-%m-%d).sql.gz"
  temp="$target.tmp"

  log "[$proj] dumping -> $target"

  # The database name and user come from the postgres container's own
  # POSTGRES_DB / POSTGRES_USER -- what it was actually started with -- so this
  # works whether the deploy keeps PG_DB / PG_USER in .env, in a secrets
  # manager, or leaves them at the compose defaults.
  #
  # -T disables a TTY (cron has no terminal); --clean / --if-exists makes the
  # dump restorable on top of an existing database without manual cleanup;
  # --no-owner / --no-privileges keeps it portable across PG roles. We pipe
  # through gzip on the host, write to a .tmp file, and rename only on success
  # so a partial dump can never overwrite a previous good one.
  # shellcheck disable=SC2016  # expanded inside the container, not here
  if docker compose exec -T postgres sh -c \
        'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-privileges --clean --if-exists' \
     | gzip -9 > "$temp"; then
    mv "$temp" "$target"
    log "[$proj] OK ($(du -h "$target" | cut -f1)): $target"
  else
    local rc=$?
    rm -f "$temp"
    log "[$proj] ERROR: pg_dump failed (exit $rc)" >&2
    return "$rc"
  fi

  # ── Prune old backups ───────────────────────────────────────────────────────
  # Keep only the most recent $KEEP files matching the strict naming pattern,
  # in this instance's own folder. Count-based rather than mtime-based, and
  # constrained to our own filename pattern so nothing else could be touched
  # even by accident.
  local old=() f
  while IFS= read -r f; do old+=("$f"); done \
    < <(ls -1t "$dir"/nexum-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
  if [ "${#old[@]}" -gt 0 ]; then
    log "[$proj] pruning ${#old[@]} old backup(s) (keeping $KEEP):"
    for f in "${old[@]}"; do
      log "[$proj]   removing $f"
      rm -f -- "$f"
    done
  else
    log "[$proj] no old backups to prune (keeping $KEEP)"
  fi
}

failed=()
for project_dir in "${PROJECT_DIRS[@]}"; do
  if ! (backup_instance "$project_dir"); then
    failed+=("$project_dir")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  log "ERROR: ${#failed[@]} of ${#PROJECT_DIRS[@]} backup(s) failed: ${failed[*]}" >&2
  exit 1
fi
log "all ${#PROJECT_DIRS[@]} backup(s) OK"
