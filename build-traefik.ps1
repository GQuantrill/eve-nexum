# Deploy nexum with the Traefik overlay: pull latest, rebuild, restart.
#
# BOTH compose files are required - a plain `up` without the traefik overlay
# 404s the live site. Passing explicit -f flags also means the dev-only
# docker-compose.override.yml is deliberately NOT loaded.
#
# Stops on the first failure (a failed pull/build never reaches `up`), so a
# broken build never replaces the running site.
#
# Usage:  .\build-traefik.ps1
#   (first run may need:  Set-ExecutionPolicy -Scope Process RemoteSigned)

$ErrorActionPreference = 'Stop'

# Run from the script's own directory (repo root), regardless of cwd.
Set-Location -Path $PSScriptRoot

$compose = @('-f', 'docker-compose.yml', '-f', 'docker-compose.traefik.yml')

# Opt-in: set PG_HOST_BIND to publish Postgres on the host (loopback by
# default - see docker-compose.dbhost.yml). Unset => Postgres stays internal to
# the compose network. Under a secrets manager, put PG_HOST_BIND in your secrets.
if (-not [string]::IsNullOrEmpty($env:PG_HOST_BIND)) {
    $compose += @('-f', 'docker-compose.dbhost.yml')
    Write-Host "==> PG_HOST_BIND=$($env:PG_HOST_BIND) set: publishing Postgres on the host" -ForegroundColor Cyan
}

# External commands (git/docker) don't throw on non-zero exit, so check
# $LASTEXITCODE after each and stop if it failed.
function Invoke-Step {
    param([string] $Label, [scriptblock] $Command)
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}

Invoke-Step '[1/3] git pull'             { git pull }
Invoke-Step '[2/3] docker compose build' { docker compose @compose build }
# up -d reconciles (only changed services are recreated); --remove-orphans also
# drops containers for services deleted from the compose files. Scoped to this
# compose project, so a separate stack (e.g. QA) is untouched.
Invoke-Step '[3/4] docker compose up -d' { docker compose @compose up -d --remove-orphans }

# Reclaim disk from images this build superseded. Dangling-only (no -a), so it
# never touches an in-use image. Called directly (not via Invoke-Step) so a
# non-zero exit is non-fatal and can't fail an otherwise-good deploy.
Write-Host '==> [4/4] prune dangling images' -ForegroundColor Cyan
docker image prune -f

Write-Host '==> done. Container status:' -ForegroundColor Green
docker compose @compose ps
