// zKillboard's activity grid for a system: kills by UTC weekday and hour over
// its rolling window (about 90 days), from /api/stats/solarSystemID/<id>/. It's
// the long history behind the PvP forecast -- we only started recording kills
// ourselves recently, zKill has always been counting.
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/cache.js';
import { ZKB_AGENT } from '../utils/zkill.js';

const log = createLogger('zkillActivity');

/** zKill's activity window. It doesn't say so in the payload; 90 days is what
 *  it covers (Jita's grid sums to ~90 days of its kill rate). */
export const ZKILL_ACTIVITY_DAYS = 90;

/** grid[weekday][hour]: weekday 0 = Sunday, as zKill and getUTCDay() both
 *  number them; hour 0-23 UTC. */
export type ActivityGrid = number[][];

export function emptyGrid(): ActivityGrid {
  return Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
}

/**
 * Read zKill's `activity` block. Each weekday is a 24-entry list, or -- when
 * some hours are empty -- an object keyed by the hours that aren't. Anything
 * else (missing, malformed, negative) reads as zero rather than failing.
 */
export function parseZkillActivity(activity: unknown): ActivityGrid {
  const grid = emptyGrid();
  if (!activity || typeof activity !== 'object') return grid;
  const a = activity as Record<string, unknown>;
  for (let d = 0; d < 7; d++) {
    const row = a[String(d)];
    if (!row || typeof row !== 'object') continue;
    for (let h = 0; h < 24; h++) {
      const v = Array.isArray(row) ? row[h] : (row as Record<string, unknown>)[String(h)];
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
      grid[d][h] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10_000_000) : 0;
    }
  }
  return grid;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // the grid moves slowly; one fetch an hour per system
const FETCH_TIMEOUT_MS = 8_000;
const cache = new TtlCache<number, ActivityGrid>(CACHE_TTL_MS, 30 * 60 * 1000);
const inflight = new Map<number, Promise<ActivityGrid | null>>();

/** The grid for a system, or null when zKill couldn't be reached (and nothing
 *  older is cached). A system zKill has no kills for is an all-zero grid. */
export async function fetchZkillActivity(systemId: number): Promise<ActivityGrid | null> {
  if (!Number.isInteger(systemId) || systemId <= 0 || systemId > 100_000_000) return null;
  const fresh = cache.get(systemId);
  if (fresh) return fresh.value;
  const running = inflight.get(systemId);
  if (running) return running;

  const p = (async () => {
    try {
      // Built from the bounded number, never raw text. zKill redirects this to
      // .../kills/; fetch follows it.
      const res = await fetch(`https://zkillboard.com/api/stats/solarSystemID/${systemId}/`, {
        headers: { 'User-Agent': ZKB_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn(`zKillboard stats returned ${res.status} for system ${systemId}`);
        return cache.peek(systemId)?.value ?? null;
      }
      const body = (await res.json()) as { activity?: unknown } | null;
      const grid = parseZkillActivity(body && typeof body === 'object' ? body.activity : null);
      cache.set(systemId, grid);
      return grid;
    } catch (err) {
      log.warn(`zKillboard stats failed for system ${systemId}:`, (err as Error).message);
      return cache.peek(systemId)?.value ?? null;
    } finally {
      inflight.delete(systemId);
    }
  })();
  inflight.set(systemId, p);
  return p;
}
