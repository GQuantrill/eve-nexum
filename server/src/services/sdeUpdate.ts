import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { loadRouteGraph } from './routeGraph.js';
import { resetA0Cache } from '../routes/systems.js';
import { resetWormholeCache } from '../routes/wormholes.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sde-update');

// EVE downtime is 11:00 UTC; CCP publishes the new SDE export shortly after.
// We check once a day a little later (default 11:30 UTC, override via
// SDE_CHECK_UTC) so the export is up by the time we look.
const DAY_MS = 24 * 60 * 60 * 1000;
// Delay before the post-boot catch-up check, so it doesn't compete with the
// rest of startup (route graph, standings, etc.).
const BOOT_CHECK_DELAY_MS = 3 * 60 * 1000;

// CCP's "latest" SDE URL 302-redirects to a versioned filename embedding the
// build number, e.g. `…/eve-online-static-data-3365090-jsonl.zip`. Same URL the
// importer uses; kept here so the server can report the available build too.
const SDE_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

let running = false;

// Pull the CCP build number out of an SDE filename/URL → "3365090".
function parseBuild(s: string): string | null {
  return s.match(/static-data-(\d+)-jsonl/)?.[1] ?? null;
}

async function storedVersion(): Promise<string | null> {
  return (await getInstalledSde()).version;
}

/**
 * The SDE build currently imported into this DB, plus when it was recorded.
 * Returns nulls on a never-seeded DB (table may not exist yet).
 */
export async function getInstalledSde(): Promise<{ version: string | null; updatedAt: string | null }> {
  try {
    const { rows } = await db.query<{ value: string; updated_at: string }>(
      `SELECT value, updated_at FROM sde_meta WHERE key = 'sde_version'`,
    );
    return { version: rows[0]?.value ?? null, updatedAt: rows[0]?.updated_at ?? null };
  } catch {
    return { version: null, updatedAt: null };
  }
}

// Cache the remote-build lookup so a burst of callers makes at most one HEAD to
// CCP. Successes are good for an hour (the SDE changes ~daily); failures retry
// after 5 min so a brief CCP outage doesn't pin "unknown" for an hour.
const LATEST_TTL_OK_MS  = 60 * 60 * 1000;
const LATEST_TTL_ERR_MS = 5 * 60 * 1000;
let latestCache: { build: string | null; at: number } | null = null;

async function fetchRemoteBuild(): Promise<string | null> {
  try {
    const res = await fetch(SDE_URL, { method: 'HEAD', redirect: 'manual' });
    const build = parseBuild(res.headers.get('location') ?? '');
    if (build) return build;
    // URL shape changed — fall back to a stable content identifier.
    const head = await fetch(SDE_URL, { method: 'HEAD' });
    return head.headers.get('etag') ?? head.headers.get('last-modified');
  } catch (err) {
    log.warn(`could not determine latest SDE build: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The latest SDE build CCP currently offers, without downloading it. Cached;
 * `at` is when the value was actually fetched. `build` is null if CCP was
 * unreachable.
 */
export async function fetchLatestSdeBuild(): Promise<{ build: string | null; at: number }> {
  const now = Date.now();
  if (latestCache) {
    const ttl = latestCache.build ? LATEST_TTL_OK_MS : LATEST_TTL_ERR_MS;
    if (now - latestCache.at < ttl) return latestCache;
  }
  latestCache = { build: await fetchRemoteBuild(), at: now };
  return latestCache;
}

// Run the compiled importer as a child process. It lives in the same image, so
// it shares the seed files and env. Running it out-of-process keeps it on its
// own pg pool — its `db.end()` at finish won't touch the server's pool — and
// isolates the import's memory from the long-lived server. The importer does
// its own HEAD/build-number check, so on a no-change day this is a cheap no-op.
// Hard cap on a single import. A stalled download (no socket timeout) would
// otherwise leave the child running forever, so runImporter would never resolve
// and the `running` guard would stay stuck — wedging every future check. Kill
// it past this and treat as a failed run.
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

function runImporter(): Promise<number> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'dist/scripts/setup-db.js');
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    const timer = setTimeout(() => {
      log.error(`importer exceeded ${IMPORT_TIMEOUT_MS / 60000} min; killing it`);
      child.kill('SIGKILL');
    }, IMPORT_TIMEOUT_MS);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.error(`importer failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

// Outcome of the most recent auto-update check, surfaced via getLastSdeCheck()
// so /api/sde/version can show whether the updater is actually firing — the
// thing you can't tell from installed/latest alone.
export type SdeCheckResult = 'updated' | 'unchanged' | 'error' | 'skipped';
let lastCheck: { at: number; result: SdeCheckResult } | null = null;

export function getLastSdeCheck(): { at: number; result: SdeCheckResult } | null {
  return lastCheck;
}

/**
 * Run the importer, then reload the in-memory route graph if the SDE build
 * actually changed (new systems / stargates take effect without a restart).
 */
export async function checkSde(): Promise<void> {
  if (running) {
    log.warn('previous SDE check still running; skipping this tick');
    lastCheck = { at: Date.now(), result: 'skipped' };
    return;
  }
  running = true;
  let result: SdeCheckResult = 'error';
  try {
    const before = await storedVersion();
    log.info(`SDE check (current build ${before ?? 'unknown'})`);
    const code = await runImporter();
    if (code !== 0) {
      log.error(`importer exited with code ${code}`);
      return;
    }
    const after = await storedVersion();
    if (after && after !== before) {
      log.info(`SDE updated ${before ?? 'unknown'} -> ${after}; reloading caches`);
      await loadRouteGraph();
      resetA0Cache();
      resetWormholeCache();
      result = 'updated';
    } else {
      log.info('SDE unchanged');
      result = 'unchanged';
    }
  } catch (err) {
    log.error(`SDE check failed: ${(err as Error).message}`);
  } finally {
    lastCheck = { at: Date.now(), result };
    running = false;
  }
}

// Milliseconds from now until the next HH:MM UTC.
function msUntilNextUtc(hour: number, minute: number): number {
  const now  = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Schedule the daily SDE check at config.sdeCheckUtc. No-op when disabled via
 * SDE_AUTO_UPDATE=0. Call once at server startup.
 */
export function startSdeAutoUpdate(): void {
  if (!config.sdeAutoUpdate) {
    log.info('auto-update disabled (SDE_AUTO_UPDATE=0)');
    return;
  }
  const [hh, mm] = config.sdeCheckUtc.split(':');
  const hour   = parseInt(hh, 10);
  const minute = parseInt(mm, 10);
  const delay  = msUntilNextUtc(hour, minute);

  // Catch-up a few minutes after boot. Without this the first check is the next
  // daily slot, so a restart after the slot (or a build CCP publishes off the
  // 11:00-downtime cadence) leaves us stale for up to ~24h. The check is a cheap
  // HEAD + early-return when nothing changed, so running it on every boot is fine.
  setTimeout(() => { void checkSde(); }, BOOT_CHECK_DELAY_MS);

  log.info(`auto-update on; catch-up in ${Math.round(BOOT_CHECK_DELAY_MS / 60000)} min, then daily at ${config.sdeCheckUtc} UTC`);
  setTimeout(() => {
    void checkSde();
    setInterval(() => { void checkSde(); }, DAY_MS);
  }, delay);
}
