// Update check: compares the running version (package.json) against the latest
// GitHub release of the upstream project. Best-effort and cached, so many admin
// polls collapse to at most a few GitHub calls per day. The URL is a fixed,
// hard-coded public endpoint — no user input, no SSRF surface.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('versionCheck');

// Upstream project — self-hosted deployments are notified when it ships a new
// release, not when their own fork tags something.
const REPO = 'GQuantrill/eve-nexum';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const OK_TTL_MS   = 6 * 60 * 60 * 1000; // cache a good result 6h
const FAIL_TTL_MS = 15 * 60 * 1000;     // retry a failure after 15m

// Running version, read from package.json at the process cwd (/app in Docker,
// server/ in dev — both have package.json at the root). Mirrors telemetry.
function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Numeric [major, minor, patch]; ignores any pre-release suffix and a leading v.
function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

interface LatestRelease { tag: string; url: string; }
let cache: { until: number; latest: LatestRelease | null } | null = null;

async function fetchLatest(): Promise<LatestRelease | null> {
  try {
    const r = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nexum-version-check' },
      signal:  AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!r.ok) { log.warn(`GitHub releases API returned ${r.status}`); return null; }
    const j = await r.json() as { tag_name?: string; html_url?: string };
    if (!j.tag_name || !j.html_url) return null;
    return { tag: j.tag_name, url: j.html_url };
  } catch (e) {
    log.warn(`latest-release fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function getLatest(): Promise<LatestRelease | null> {
  if (cache && Date.now() < cache.until) return cache.latest;
  const latest = await fetchLatest();
  cache = { until: Date.now() + (latest ? OK_TTL_MS : FAIL_TTL_MS), latest };
  return latest;
}

export interface VersionStatus {
  current:         string;
  latest:          string | null;
  updateAvailable: boolean;
  releaseUrl:      string | null;
}

export async function getVersionStatus(): Promise<VersionStatus> {
  const current = currentVersion();
  const latest  = await getLatest();
  const latestVersion = latest ? latest.tag.replace(/^v/i, '') : null;
  return {
    current,
    latest:          latestVersion,
    updateAvailable: latestVersion != null && isNewer(latestVersion, current),
    releaseUrl:      latest?.url ?? null,
  };
}
