// PvP history per system, for the "when is it busy" forecast.
//
// The forecast's long history is zKillboard's weekday/hour activity grid
// (zkillActivity.ts). Alongside it, every player kill the live R2Z2 feed sees is
// counted into its system's UTC hour and kept for PVP_HISTORY_DAYS: that gives
// the "last 24 hours" count straight away, and stands in for zKill's grid when
// zKill can't be reached. The feed covers wormhole space too.
//
// Counts are batched in memory and flushed once a minute with an additive
// upsert, so a busy feed costs one query a minute, not one per kill. The feed
// saves its position only after flushing these counts, and on boot replays
// earlier killmails without counting them again (killFeed.ts), so a kill can't
// be counted twice across a restart; at worst a crash loses the last minute.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { fetchZkillActivity, emptyGrid, ZKILL_ACTIVITY_DAYS, type ActivityGrid } from './zkillActivity.js';

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
  /** Where the weekday/hour grid came from: zKillboard's ~90-day history, or
   *  (when zKill can't be reached) our own recording from the live feed. */
  source: 'zkill' | 'live';
  /** grid[weekday][hour] kill counts, weekday 0 = Sunday, hour UTC. */
  grid: ActivityGrid;
  total: number;
  /** How many days the grid covers. */
  days: number;
  /** Player kills the live (R2Z2) feed has seen here in the last 24 hours --
   *  fresher than zKill's grid, and counted the moment they land. */
  recent24h: number;
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

/** Our own weekday/hour grid for a system from the recorded live feed. */
export async function getLocalGrid(eveSystemId: number): Promise<{ grid: ActivityGrid; total: number; days: number }> {
  const { rows } = await db.query<{ d: number; h: number; kills: string }>(
    `SELECT EXTRACT(DOW  FROM hour AT TIME ZONE 'UTC')::int AS d,
            EXTRACT(HOUR FROM hour AT TIME ZONE 'UTC')::int AS h,
            SUM(kills) AS kills
       FROM system_pvp_hours
      WHERE eve_system_id = $1 AND hour >= NOW() - make_interval(days => $2)
      GROUP BY 1, 2`,
    [eveSystemId, PVP_HISTORY_DAYS],
  );
  const grid = emptyGrid();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.kills);
    grid[r.d][r.h] = n;
    total += n;
  }
  const earliest = await earliestHour();
  const days = earliest == null ? 0
    : Math.min(PVP_HISTORY_DAYS, Math.max(1, Math.ceil((Date.now() - earliest) / DAY_MS)));
  return { grid, total, days };
}

/** Player kills in the last 24 hours: what's flushed, plus what's still
 *  waiting for the next flush so a kill shows within moments. */
export async function recentPvpKills(eveSystemId: number, now = Date.now()): Promise<number> {
  const since = hourFloor(now) - 23 * HOUR_MS;
  const { rows } = await db.query<{ kills: string | null }>(
    `SELECT SUM(kills) AS kills FROM system_pvp_hours WHERE eve_system_id = $1 AND hour >= $2`,
    [eveSystemId, new Date(since)],
  );
  let n = Number(rows[0]?.kills ?? 0);
  const prefix = `${eveSystemId}:`;
  for (const [key, count] of pending) {
    if (key.startsWith(prefix) && Number(key.slice(prefix.length)) >= since) n += count;
  }
  return n;
}

const sumGrid = (g: ActivityGrid) => g.reduce((a, row) => a + row.reduce((b, n) => b + n, 0), 0);

export async function getPvpForecast(eveSystemId: number): Promise<PvpForecast> {
  const [zkill, recent24h] = await Promise.all([fetchZkillActivity(eveSystemId), recentPvpKills(eveSystemId)]);
  // zKill's grid is the long history and wins whenever we have it. Ours is the
  // fallback; the two are never added together, because zKill already counts
  // every kill the live feed hands us.
  if (zkill) return { source: 'zkill', grid: zkill, total: sumGrid(zkill), days: ZKILL_ACTIVITY_DAYS, recent24h };
  const local = await getLocalGrid(eveSystemId);
  return { source: 'live', ...local, recent24h };
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
