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

  echo "==> [1/3] git pull"
  git pull

  echo "==> [2/3] docker compose build"
  docker compose "${compose[@]}" build

  echo "==> [3/3] docker compose up -d"
  docker compose "${compose[@]}" up -d

  echo "==> done. Container status:"
  docker compose "${compose[@]}" ps
}

main "$@"
