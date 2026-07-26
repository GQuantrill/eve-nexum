#!/usr/bin/env bash
#
# Deploy nexum with the Traefik overlay: pull latest, rebuild, restart.
#
# BOTH compose files are required — a plain `up` without the traefik overlay
# 404s the live site. Passing explicit -f flags also means the dev-only
# docker-compose.override.yml is deliberately NOT loaded.
#
# `set -e` matters here: if `git pull` or `build` fails, the script stops
# BEFORE `up`, so a broken build never replaces the running site.
#
# Usage:  ./build-traefik.sh
set -euo pipefail

# The whole script lives inside main() so that a `git pull` which updates this
# very file mid-run can't make bash misread the not-yet-executed lines — bash
# has already parsed the function before main runs.
main() {
  # Run from the repo root (where the compose files are), regardless of cwd.
  cd "$(dirname "$0")"

  local compose=(-f docker-compose.yml -f docker-compose.traefik.yml)

  # Opt-in: set PG_HOST_BIND to publish Postgres on the host (loopback by
  # default -- see docker-compose.dbhost.yml). Unset => Postgres stays internal
  # to the compose network. Under Infisical, put PG_HOST_BIND in your secrets
  # and run this via `infisical run -- ./build-traefik.sh`.
  if [[ -n "${PG_HOST_BIND:-}" ]]; then
    compose+=(-f docker-compose.dbhost.yml)
    echo "==> PG_HOST_BIND=${PG_HOST_BIND} set: publishing Postgres on the host"
  fi

  echo "==> [1/3] git pull"
  git pull

  echo "==> [2/3] docker compose build"
  docker compose "${compose[@]}" build

  echo "==> [3/4] docker compose up -d"
  # up -d already reconciles: it recomputes each service's config hash and
  # recreates only the ones whose config or image changed, leaving the rest
  # running. --remove-orphans also drops containers for services deleted from
  # the compose files (config-hash reconciliation doesn't cover those, so they'd
  # otherwise linger unrouted). Scoped to this compose project, so a separate
  # stack (e.g. QA with its own project name) is untouched.
  docker compose "${compose[@]}" up -d --remove-orphans

  # Reclaim disk from images this build superseded. Dangling-only (no -a), so it
  # never touches an image a container is using; non-fatal so a prune hiccup
  # can't fail an otherwise-good deploy.
  echo "==> [4/4] prune dangling images"
  docker image prune -f || true

  echo "==> done. Container status:"
  docker compose "${compose[@]}" ps
}

main "$@"
