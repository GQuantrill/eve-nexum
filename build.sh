#!/usr/bin/env bash
#
# Local/dev build: pull latest, rebuild, restart — WITHOUT the Traefik overlay.
#
# Runs bare `docker compose`, so it loads docker-compose.yml +
# docker-compose.override.yml (the dev override). It does NOT route through
# Traefik, so this is for LOCAL / dev use — for the live site use
# ./build-traefik.sh (a plain `up` without the overlay 404s the live site).
#
# `set -e` stops before `up` if `git pull` or `build` fails.
#
# Usage:  ./build.sh
set -euo pipefail

# Wrapped in main() so a `git pull` that updates this file mid-run can't make
# bash misread the not-yet-executed lines (already parsed before main runs).
main() {
  cd "$(dirname "$0")"

  echo "==> [1/3] git pull"
  git pull

  echo "==> [2/3] docker compose build"
  docker compose build

  echo "==> [3/3] docker compose up -d"
  docker compose up -d

  echo "==> done. Container status:"
  docker compose ps
}

main "$@"
