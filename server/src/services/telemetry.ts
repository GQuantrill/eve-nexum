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
export async function getInstanceId(): Promise<string> {
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

// Aggregate scale counts for the ping: how many maps and users this install has.
// Counts only — no ids, names, or any identifying detail. Failure is non-fatal;
// we just omit the count (null) rather than skip the whole ping.
async function collectCounts(): Promise<{ mapCount: number | null; userCount: number | null }> {
  try {
    const [maps, users] = await Promise.all([
      db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM maps`),
      db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM users`),
    ]);
    return { mapCount: Number(maps.rows[0]?.n ?? 0), userCount: Number(users.rows[0]?.n ?? 0) };
  } catch (err) {
    log.warn('count collection failed:', err instanceof Error ? err.message : String(err));
    return { mapCount: null, userCount: null };
  }
}

/** What the ping reports beyond the two totals. Every value is a count. */
export interface UsageStats {
  active1d: number; active7d: number; active30d: number;
  accounts30d: number; desktop30d: number; maps30d: number;
  mode: 'solo' | 'corp' | 'alliance';
  features: { chainNumbering: number; autoRemove: number; crossMapSync: number; discord: number };
  languages: Record<string, number>;
}

/** When a pilot last used Nexum: opened it, had their location read, or signed in. */
const LAST_ACTIVE = `GREATEST(u.last_active_at, u.last_seen_at, u.last_login_at)`;

// Usage counts for the ping. Counts only, like collectCounts; null when they
// can't be read (an older schema mid-upgrade), and the ping goes without them.
export async function collectUsageStats(): Promise<UsageStats | null> {
  try {
    const { rows: [a] } = await db.query<Record<string, number>>(
      `SELECT COUNT(*) FILTER (WHERE ${LAST_ACTIVE} > NOW() - interval '1 day')::int  AS "active1d",
              COUNT(*) FILTER (WHERE ${LAST_ACTIVE} > NOW() - interval '7 days')::int AS "active7d",
              COUNT(*) FILTER (WHERE ${LAST_ACTIVE} > NOW() - interval '30 days')::int AS "active30d",
              COUNT(DISTINCT COALESCE(u.owner_id, -u.id)) FILTER (WHERE ${LAST_ACTIVE} > NOW() - interval '30 days')::int AS "accounts30d",
              COUNT(*) FILTER (WHERE u.last_desktop_at > NOW() - interval '30 days')::int AS "desktop30d"
         FROM users u`);
    const { rows: [m] } = await db.query<Record<string, number>>(
      `SELECT COUNT(*) FILTER (WHERE updated_at > NOW() - interval '30 days')::int AS "maps30d",
              COUNT(*) FILTER (WHERE chain_numbering)::int        AS "chainNumbering",
              COUNT(*) FILTER (WHERE lazy_remove_wormholes)::int  AS "autoRemove",
              COUNT(*) FILTER (WHERE cross_map_sync)::int         AS "crossMapSync"
         FROM maps`);
    const { rows: [d] } = await db.query<{ n: number }>(
      `SELECT ((SELECT COUNT(*) FROM corp_discord_settings
                 WHERE connections_webhook IS NOT NULL OR chains_webhook IS NOT NULL)
             + (SELECT COUNT(*) FROM alliance_discord_settings
                 WHERE connections_webhook IS NOT NULL OR chains_webhook IS NOT NULL))::int AS n`);
    const { rows: langs } = await db.query<{ lang: string; n: number }>(
      `SELECT u.ui_lang AS lang, COUNT(*)::int AS n FROM users u
        WHERE u.ui_lang IS NOT NULL AND ${LAST_ACTIVE} > NOW() - interval '30 days'
        GROUP BY u.ui_lang`);
    return {
      active1d: a.active1d, active7d: a.active7d, active30d: a.active30d,
      accounts30d: a.accounts30d, desktop30d: a.desktop30d, maps30d: m.maps30d,
      mode: config.allianceMode ? 'alliance' : config.corpMode ? 'corp' : 'solo',
      features: {
        chainNumbering: m.chainNumbering, autoRemove: m.autoRemove,
        crossMapSync: m.crossMapSync, discord: d.n,
      },
      languages: Object.fromEntries(langs.map((r) => [r.lang, r.n])),
    };
  } catch (err) {
    log.warn('usage stats failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function sendPing(instanceId: string): Promise<void> {
  try {
    const { mapCount, userCount } = await collectCounts();
    const stats = await collectUsageStats();
    const res = await fetch(config.telemetry.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ version: appVersion(), instanceId, mapCount, userCount, ...(stats ? { stats } : {}) }),
      signal:  AbortSignal.timeout(10_000),
    });
    // Log the OUTCOME, not just failures — otherwise "enabled" in the log looks
    // like success even when the POST never lands (e.g. a host that can't reach
    // its own public URL). The collector replies 204 on a successful upsert.
    if (res.ok) log.info(`ping accepted by collector (status ${res.status})`);
    else        log.warn(`ping rejected (status ${res.status})`);
  } catch (err) {
    // Offline / collector down / DNS / can't reach own public URL — all
    // non-fatal and expected; but log it so an empty table is explainable.
    log.warn('ping failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Anonymous deployment ping, on by default (NEXUM_TELEMETRY=0 turns it off).
 * Sends the app version, a random per-instance id and aggregate counts, now
 * and once a day after. No identifying data. Wrapped so a failure here never
 * affects boot.
 */
export async function startTelemetry(): Promise<void> {
  if (!config.telemetry.enabled) return;
  try {
    log.info(
      `anonymous telemetry on: sending the version and aggregate counts to ${config.telemetry.url} ` +
      `once a day (set NEXUM_TELEMETRY=0 to turn it off)`,
    );
    const instanceId = await getInstanceId();
    await sendPing(instanceId);
    setInterval(() => { void sendPing(instanceId); }, DAY_MS);
  } catch (err) {
    log.warn('telemetry init failed:', err instanceof Error ? err.message : String(err));
  }
}
