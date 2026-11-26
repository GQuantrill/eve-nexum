import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

// NPC buyers of blue loot (Sleeper salvage), for the Closest Systems
// suggestions. ESI has no "NPC buyers" list, but the market tells them apart:
// an NPC buy order runs 365 days, and a player's can't run longer than 90. So
// each k-space region's buy orders for the four items are read, the 365-day
// ones at NPC stations kept, and the table replaced whole.
//
// NPC buyers almost never move, so this runs about once a week, slowly: three
// nexum instances share one IP and ESI's error limit is per IP, so a run is
// ~160 calls (40 regions with NPC stations, four items) paced a second apart,
// and stops early on errors.

const log = createLogger('blueLoot');

export const BLUE_LOOT_TYPES = [
  30744, // Neural Network Analyzer
  30745, // Sleeper Data Library
  30746, // Ancient Coordinates Database
  30747, // Sleeper Drone AI Nexus
] as const;

const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS   = 6 * 60 * 60 * 1000;
const PACE_MS          = 1000;
/** Give up the run (keeping last week's list) after this many failed calls. */
const MAX_FAILURES     = 5;
/** ...or when ESI's per-IP error allowance gets this low. */
const MIN_ERROR_REMAIN = 40;
const NPC_ORDER_DAYS   = 365;

export interface MarketOrder {
  duration:      number;
  is_buy_order:  boolean;
  location_id:   number;
  system_id:     number;
  type_id:       number;
}

/** The NPC buyers in one batch of orders: station -> system and item types. */
export function npcBuyers(
  orders: MarketOrder[], npcStations: ReadonlySet<number>,
): Map<number, { systemId: number; types: Set<number> }> {
  const out = new Map<number, { systemId: number; types: Set<number> }>();
  for (const o of orders) {
    if (!o.is_buy_order || o.duration !== NPC_ORDER_DAYS || !npcStations.has(o.location_id)) continue;
    let b = out.get(o.location_id);
    if (!b) { b = { systemId: o.system_id, types: new Set() }; out.set(o.location_id, b); }
    b.types.add(o.type_id);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;

async function due(): Promise<boolean> {
  const { rows } = await db.query<{ finished_at: Date }>(`SELECT finished_at FROM blue_loot_refresh WHERE id`);
  return !rows[0] || Date.now() - rows[0].finished_at.getTime() > REFRESH_EVERY_MS;
}

export async function refreshBlueLoot(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { rows: stationRows } = await db.query<{ station_id: string }>(`SELECT station_id::text FROM npc_stations`);
    const npcStations = new Set(stationRows.map((r) => Number(r.station_id)));
    if (npcStations.size === 0) { log.warn('No NPC stations imported yet; skipping blue loot refresh'); return; }
    // Regions with an NPC station: k-space, so no wormhole regions.
    const { rows: regionRows } = await db.query<{ region_id: number }>(
      `SELECT DISTINCT s.region_id FROM npc_stations n JOIN solar_systems s ON s.id = n.solar_system_id
        WHERE s.region_id IS NOT NULL ORDER BY s.region_id`);

    const buyers = new Map<number, { systemId: number; types: Set<number> }>();
    let failures = 0;
    for (const { region_id: region } of regionRows) {
      for (const type of BLUE_LOOT_TYPES) {
        let page = 1, pages = 1;
        do {
          await sleep(PACE_MS);
          const res = await esiFetch(
            `https://esi.evetech.net/latest/markets/${region}/orders/?datasource=tranquility&order_type=buy&type_id=${type}&page=${page}`,
          ).catch(() => null);
          const remain = Number(res?.headers.get('x-esi-error-limit-remain') ?? NaN);
          if (!res || !res.ok) {
            failures++;
            log.warn(`Market orders ${region}/${type} failed (${res?.status ?? 'network'})`);
            if (failures >= MAX_FAILURES || remain < MIN_ERROR_REMAIN) {
              log.warn('Too many ESI errors; blue loot refresh abandoned, keeping the previous list');
              return;
            }
            break;
          }
          if (remain < MIN_ERROR_REMAIN) {
            log.warn(`ESI error allowance low (${remain}); blue loot refresh abandoned, keeping the previous list`);
            return;
          }
          pages = parseInt(res.headers.get('x-pages') ?? '1', 10) || 1;
          for (const [station, b] of npcBuyers(await res.json() as MarketOrder[], npcStations)) {
            const have = buyers.get(station);
            if (have) b.types.forEach((t) => have.types.add(t));
            else buyers.set(station, b);
          }
        } while (++page <= pages);
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM blue_loot_buyers');
      for (const [station, b] of buyers) {
        await client.query(
          `INSERT INTO blue_loot_buyers (station_id, solar_system_id, type_ids) VALUES ($1, $2, $3)`,
          [station, b.systemId, [...b.types].sort()]);
      }
      await client.query(
        `INSERT INTO blue_loot_refresh (id, finished_at) VALUES (TRUE, NOW())
         ON CONFLICT (id) DO UPDATE SET finished_at = NOW()`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    log.info(`Blue loot buyers refreshed: ${buyers.size} stations across ${regionRows.length} regions`);
  } catch (err) {
    log.error('Blue loot refresh failed:', err);
  } finally {
    running = false;
  }
}

/** Checks every few hours and refreshes when the list is a week old. The
 *  first check waits a few minutes, spread at random so instances restarted
 *  together don't all start at once. */
export function startBlueLootRefresher(): void {
  const check = () => { void due().then((d) => (d ? refreshBlueLoot() : undefined)).catch(() => {}); };
  setTimeout(check, 5 * 60_000 + Math.random() * 10 * 60_000);
  setInterval(check, CHECK_EVERY_MS);
}

/** System -> the blue loot item types bought there (by any of its stations). */
export async function blueLootSystems(): Promise<Map<number, number[]>> {
  const { rows } = await db.query<{ solar_system_id: number; type_ids: number[] }>(
    `SELECT solar_system_id, array_agg(DISTINCT t ORDER BY t) AS type_ids
       FROM blue_loot_buyers, unnest(type_ids) AS t GROUP BY solar_system_id`);
  return new Map(rows.map((r) => [r.solar_system_id, r.type_ids]));
}
