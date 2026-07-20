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
Invoke-Step '[3/3] docker compose up -d' { docker compose @compose up -d }

Write-Host '==> done. Container status:' -ForegroundColor Green
docker compose @compose ps
