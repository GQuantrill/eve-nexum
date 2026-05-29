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

let running = false;

async function storedVersion(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ value: string }>(
      `SELECT value FROM sde_meta WHERE key = 'sde_version'`,
    );
    return rows[0]?.value ?? null;
  } catch {
    return null; // table may not exist yet on a never-seeded DB
  }
}

// Run the compiled importer as a child process. It lives in the same image, so
// it shares the seed files and env. Running it out-of-process keeps it on its
// own pg pool — its `db.end()` at finish won't touch the server's pool — and
// isolates the import's memory from the long-lived server. The importer does
// its own HEAD/build-number check, so on a no-change day this is a cheap no-op.
function runImporter(): Promise<number> {
  return new Promise((resolve) => {
    const script = join(process.cwd(), 'dist/scripts/setup-db.js');
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      log.error(`importer failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Run the importer, then reload the in-memory route graph if the SDE build
 * actually changed (new systems / stargates take effect without a restart).
 */
export async function checkSde(): Promise<void> {
  if (running) {
    log.warn('previous SDE check still running; skipping this tick');
    return;
  }
  running = true;
  try {
    const before = await storedVersion();
    log.info(`daily SDE check (current build ${before ?? 'unknown'})`);
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
    } else {
      log.info('SDE unchanged');
    }
  } catch (err) {
    log.error(`SDE check failed: ${(err as Error).message}`);
  } finally {
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

  log.info(`auto-update on; first check in ${Math.round(delay / 60000)} min, then daily at ${config.sdeCheckUtc} UTC`);
  setTimeout(() => {
    void checkSde();
    setInterval(() => { void checkSde(); }, DAY_MS);
  }, delay);
}
