#!/usr/bin/env bash
#
# Deploy nexum with the Traefik overlay: pull latest, rebuild, restart.
#
# The traefik + www overlays are required — a plain `up` without the traefik
# overlay 404s the live site. Passing explicit -f flags also means the dev-only
# docker-compose.override.yml is deliberately NOT loaded.
#
# Self-updating: if `git pull` changes this script, it re-execs the pulled
# version once (see the re-exec guard below) so a deploy never runs stale logic.
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

  # docker-compose.www.yml adds the www.<DOMAIN> -> apex 301 redirect. It only
  # belongs on an apex domain with a www DNS record (prod, eve-nexum.com). On a
  # subdomain instance (karmafleet.eve-nexum.com, qa.eve-nexum.com) the name
  # www.<subdomain> can't resolve -- the *.eve-nexum.com wildcard is one label
  # deep -- so its certificate order failed on every Traefik start. Unset, it's
  # on only when DOMAIN has a single dot; WWW_REDIRECT=1 or 0 forces it.
  local domain="${DOMAIN:-$(sed -n 's/^DOMAIN=//p' .env 2>/dev/null | tail -1 | tr -d "\"'\r")}"
  local www="${WWW_REDIRECT:-}"
  if [[ -z "${www}" ]]; then
    if [[ "${domain}" =~ ^[^.]+\.[^.]+$ ]]; then www=1; else www=0; fi
  fi
  if [[ "${www}" == "1" ]]; then
    compose+=(-f docker-compose.www.yml)
    echo "==> www.${domain} -> ${domain} redirect: on"
  else
    echo "==> www redirect: off (DOMAIN=${domain:-unset})"
  fi

  # Opt-in: set PG_HOST_BIND to publish Postgres on the host (loopback by
  # default -- see docker-compose.dbhost.yml). Unset => Postgres stays internal
  # to the compose network. Under Infisical, put PG_HOST_BIND in your secrets
  # and run this via `infisical run -- ./build-traefik.sh`.
  if [[ -n "${PG_HOST_BIND:-}" ]]; then
    compose+=(-f docker-compose.dbhost.yml)
    echo "==> PG_HOST_BIND=${PG_HOST_BIND} set: publishing Postgres on the host"
  fi

  echo "==> [1/4] git pull"
  local before after script
  before=$(git rev-parse HEAD)
  git pull
  after=$(git rev-parse HEAD)

  # If this pull changed the deploy script itself, the copy currently running is
  # stale: bash parsed the pre-pull version up front (see the main() note above),
  # so it would deploy with the OLD compose list / logic — exactly the "run it
  # twice" trap. Re-exec the freshly-pulled version ONCE so a deploy always runs
  # current code. NEXUM_DEPLOY_REEXECED guards against an infinite loop.
  script=$(basename "$0")
  if [[ "${before}" != "${after}" && -z "${NEXUM_DEPLOY_REEXECED:-}" ]] \
     && ! git diff --quiet "${before}" "${after}" -- "${script}"; then
    echo "==> deploy script changed in this pull — re-running the updated version"
    NEXUM_DEPLOY_REEXECED=1 exec "$0" "$@"
  fi

  echo "==> [2/4] docker compose build"
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
