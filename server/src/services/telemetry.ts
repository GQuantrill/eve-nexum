import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telemetry');

const DAY_MS = 24 * 60 * 60 * 1000;
const INSTANCE_KEY = 'telemetry_instance_id';

// App version, read from package.json relative to the process working dir
// (/app in Docker, server/ in dev — both have package.json at the cwd root).
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// A stable, random, anonymous id for this install — generated once and kept in
// sde_meta. Lets the collector count unique instances without ever needing an
// IP or anything identifying.
async function getInstanceId(): Promise<string> {
  const existing = await db.query<{ value: string }>(
    `SELECT value FROM sde_meta WHERE key = $1`, [INSTANCE_KEY],
  );
  if (existing.rows[0]?.value) return existing.rows[0].value;

  await db.query(
    `INSERT INTO sde_meta (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING`,
    [INSTANCE_KEY, randomUUID()],
  );
  // Re-read so a concurrent boot that won the insert still gives us its id.
  const settled = await db.query<{ value: string }>(
    `SELECT value FROM sde_meta WHERE key = $1`, [INSTANCE_KEY],
  );
  return settled.rows[0]?.value ?? randomUUID();
}

async function sendPing(instanceId: string): Promise<void> {
  try {
    const res = await fetch(config.telemetry.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ version: appVersion(), instanceId }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`ping rejected (status ${res.status})`);
  } catch (err) {
    // Offline / collector down / DNS — all non-fatal and expected.
    log.warn('ping failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Opt-in anonymous deployment ping (NEXUM_TELEMETRY). Sends only the app
 * version + a random per-instance id, now and once a day after. No-op unless
 * the operator opted in. Wrapped so a failure here never affects boot.
 */
export async function startTelemetry(): Promise<void> {
  if (!config.telemetry.enabled) return;
  try {
    log.info(
      `anonymous telemetry enabled — sending { version, instanceId } to ${config.telemetry.url} ` +
      `once a day (disable by unsetting NEXUM_TELEMETRY)`,
    );
    const instanceId = await getInstanceId();
    await sendPing(instanceId);
    setInterval(() => { void sendPing(instanceId); }, DAY_MS);
  } catch (err) {
    log.warn('telemetry init failed:', err instanceof Error ? err.message : String(err));
  }
}
