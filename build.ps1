# Local/dev build: pull latest, rebuild, restart - WITHOUT the Traefik overlay.
#
# Runs bare `docker compose`, so it loads docker-compose.yml +
# docker-compose.override.yml (the dev override). It does NOT route through
# Traefik, so this is for LOCAL / dev use - for the live site use
# .\build-traefik.ps1 (a plain `up` without the overlay 404s the live site).
#
# Stops on the first failure (a failed pull/build never reaches `up`).
#
# Usage:  .\build.ps1
#   (first run may need:  Set-ExecutionPolicy -Scope Process RemoteSigned)

$ErrorActionPreference = 'Stop'

# Run from the script's own directory (repo root), regardless of cwd.
Set-Location -Path $PSScriptRoot

# External commands (git/docker) don't throw on non-zero exit, so check
# $LASTEXITCODE after each and stop if it failed.
function Invoke-Step {
    param([string] $Label, [scriptblock] $Command)
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
}

Invoke-Step '[1/3] git pull'             { git pull }
Invoke-Step '[2/3] docker compose build' { docker compose build }
Invoke-Step '[3/3] docker compose up -d' { docker compose up -d }

Write-Host '==> done. Container status:' -ForegroundColor Green
docker compose ps
