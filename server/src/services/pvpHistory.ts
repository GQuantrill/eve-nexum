// PvP history per system, for the "when is it busy" forecast.
//
// Every player kill the live feed sees is counted into its system's UTC hour
// and kept for PVP_HISTORY_DAYS. Folded by hour of day, that says which hours a
// system tends to see fights -- the forecast strip in the system panel. The
// feed covers wormhole space, which CCP's hourly ESI aggregate leaves out.
//
// Counts are batched in memory and flushed once a minute with an additive
// upsert, so a busy feed costs one query a minute, not one per kill. The feed
// starts at the CURRENT sequence on boot and never replays, so a kill can't be
// counted twice across a restart; at worst a crash loses the last minute.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pvpHistory');

export const PVP_HISTORY_DAYS = 90;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FLUSH_MS = 60 * 1000;
const PRUNE_MS = 6 * HOUR_MS;
// Cap on distinct (system, hour) buckets held between flushes. Far above a
// minute of real kills; stops a DB outage turning into unbounded memory.
const MAX_PENDING = 50_000;

// "system:hourMs" -> kills
const pending = new Map<string, number>();

export function hourFloor(ms: number): number {
  return ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

/** Count one player kill. NPC kills don't belong here; the caller filters. */
export function recordPvpKill(eveSystemId: number, atMs: number, now = Date.now()): void {
  if (!Number.isInteger(eveSystemId) || eveSystemId <= 0) return;
  // A killmail time in the future is junk; one past the window is useless.
  if (atMs > now + HOUR_MS || atMs < now - PVP_HISTORY_DAYS * DAY_MS) return;
  const key = `${eveSystemId}:${hourFloor(atMs)}`;
  const n = pending.get(key);
  if (n == null && pending.size >= MAX_PENDING) return;
  pending.set(key, (n ?? 0) + 1);
}

/** Exposed for tests. */
export function pendingCount(): number {
  return pending.size;
}

export async function flushPvpKills(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending];
  pending.clear();
  const systems: number[] = [];
  const hours: Date[] = [];
  const kills: number[] = [];
  for (const [key, n] of batch) {
    const [sys, hour] = key.split(':');
    systems.push(Number(sys));
    hours.push(new Date(Number(hour)));
    kills.push(n);
  }
  try {
    await db.query(
      `INSERT INTO system_pvp_hours (eve_system_id, hour, kills)
       SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::int[])
       ON CONFLICT (eve_system_id, hour) DO UPDATE SET kills = system_pvp_hours.kills + EXCLUDED.kills`,
      [systems, hours, kills],
    );
  } catch (err) {
    // Put the counts back so the next flush retries them, within the cap.
    for (const [key, n] of batch) {
      const cur = pending.get(key);
      if (cur == null && pending.size >= MAX_PENDING) continue;
      pending.set(key, (cur ?? 0) + n);
    }
    throw err;
  }
}

export async function prunePvpHistory(): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM system_pvp_hours WHERE hour < NOW() - make_interval(days => $1)`, [PVP_HISTORY_DAYS]);
  return rowCount ?? 0;
}

export interface PvpForecast {
  /** Kills in each UTC hour of the day (index 0 = 00:00-00:59 UTC), summed
   *  over the history window. */
  byHour: number[];
  total: number;
  /** How many days of history the counts cover: PVP_HISTORY_DAYS once we've
   *  been collecting that long, fewer before. */
  days: number;
}

// Earliest hour on record, cluster-wide, cached: it only moves when the prune
// runs, and the forecast reads it on every panel open.
let earliestCache: { at: number; value: number | null } | null = null;

async function earliestHour(): Promise<number | null> {
  if (earliestCache && Date.now() - earliestCache.at < 10 * 60 * 1000) return earliestCache.value;
  const { rows } = await db.query<{ min: Date | null }>(`SELECT MIN(hour) AS min FROM system_pvp_hours`);
  const value = rows[0]?.min ? rows[0].min.getTime() : null;
  earliestCache = { at: Date.now(), value };
  return value;
}

/** Exposed for tests. */
export function resetPvpCaches(): void {
  earliestCache = null;
  pending.clear();
}

export async function getPvpForecast(eveSystemId: number): Promise<PvpForecast> {
  const { rows } = await db.query<{ h: number; kills: string }>(
    `SELECT EXTRACT(HOUR FROM hour AT TIME ZONE 'UTC')::int AS h, SUM(kills) AS kills
       FROM system_pvp_hours
      WHERE eve_system_id = $1 AND hour >= NOW() - make_interval(days => $2)
      GROUP BY 1`,
    [eveSystemId, PVP_HISTORY_DAYS],
  );
  const byHour = new Array<number>(24).fill(0);
  for (const r of rows) byHour[r.h] = Number(r.kills);
  const total = byHour.reduce((a, b) => a + b, 0);
  const earliest = await earliestHour();
  const days = earliest == null ? 0
    : Math.min(PVP_HISTORY_DAYS, Math.max(1, Math.ceil((Date.now() - earliest) / DAY_MS)));
  return { byHour, total, days };
}

export function startPvpHistory(): void {
  setInterval(() => {
    flushPvpKills().catch((err) => log.warn('flush failed:', err));
  }, FLUSH_MS).unref();
  const prune = () => {
    prunePvpHistory()
      .then((n) => { if (n > 0) { earliestCache = null; log.info(`pruned ${n} old row(s)`); } })
      .catch((err) => log.warn('prune failed:', err));
  };
  prune();
  setInterval(prune, PRUNE_MS).unref();
}
