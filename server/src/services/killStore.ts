// The last week of kills the live feed has seen, cluster-wide, in Postgres.
// The killboard's whole-map view reads it (one query for every system on a
// map, instead of a zKillboard request per system), and the per-system view
// adds it to zKill's hour-cached REST list. Written in batches once a minute;
// the killmail id is the key, so the boot-time replay can't duplicate a row.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import type { BufferedKill } from './killBuffer.js';
import type { KillTag } from './killTags.js';

const log = createLogger('killStore');

export const KILL_STORE_DAYS = 7;
const FLUSH_MS = 60_000;
const PRUNE_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING = 50_000;

export interface StoredKill extends BufferedKill {
  tags: KillTag[];
}

const pending: StoredKill[] = [];

export function storeKill(k: StoredKill): void {
  if (pending.length >= MAX_PENDING) return;
  pending.push(k);
}

const COLS = [
  'killmail_id', 'eve_system_id', 'killed_at', 'ship_type_id', 'total_value',
  'victim_character_id', 'victim_corporation_id', 'victim_alliance_id',
  'fb_character_id', 'fb_corporation_id', 'fb_alliance_id', 'fb_ship_type_id',
  'attacker_count', 'solo', 'npc', 'tags',
];

export async function flushKills(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const chunk = Math.floor(60_000 / COLS.length);
  try {
    for (let i = 0; i < batch.length; i += chunk) {
      const part = batch.slice(i, i + chunk);
      const vals: unknown[] = [];
      const ph = part.map((k) => {
        const b = vals.length;
        vals.push(
          k.killmailId, k.eveSystemId, new Date(k.atMs), k.shipTypeId, k.totalValue,
          k.victimCharacterId, k.victimCorporationId, k.victimAllianceId ?? null,
          k.finalBlowCharacterId, k.finalBlowCorporationId, k.finalBlowAllianceId ?? null, k.finalBlowShipTypeId,
          k.attackerCount ?? 0, !!k.solo, k.npc, k.tags,
        );
        return `(${COLS.map((_, j) => `$${b + j + 1}`).join(',')})`;
      }).join(',');
      await db.query(`INSERT INTO recent_kills (${COLS.join(',')}) VALUES ${ph} ON CONFLICT (killmail_id) DO NOTHING`, vals);
    }
  } catch (err) {
    // Back on the queue for the next flush, within the cap.
    pending.unshift(...batch.slice(0, Math.max(0, MAX_PENDING - pending.length)));
    throw err;
  }
}

export async function pruneKills(): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM recent_kills WHERE killed_at < NOW() - make_interval(days => $1)`, [KILL_STORE_DAYS]);
  return rowCount ?? 0;
}

interface Row {
  killmail_id: string; eve_system_id: number; killed_at: Date; ship_type_id: number; total_value: number;
  victim_character_id: number | null; victim_corporation_id: number | null; victim_alliance_id: number | null;
  fb_character_id: number | null; fb_corporation_id: number | null; fb_alliance_id: number | null; fb_ship_type_id: number;
  attacker_count: number; solo: boolean; npc: boolean; tags: KillTag[];
}

const fromRow = (r: Row): StoredKill => ({
  killmailId: Number(r.killmail_id), atMs: r.killed_at.getTime(), eveSystemId: r.eve_system_id,
  shipTypeId: r.ship_type_id, totalValue: r.total_value,
  victimCharacterId: r.victim_character_id, victimCorporationId: r.victim_corporation_id, victimAllianceId: r.victim_alliance_id,
  finalBlowCharacterId: r.fb_character_id, finalBlowCorporationId: r.fb_corporation_id, finalBlowAllianceId: r.fb_alliance_id,
  finalBlowShipTypeId: r.fb_ship_type_id, attackerCount: r.attacker_count, solo: r.solo, npc: r.npc, tags: r.tags ?? [],
});

/** Kills in these systems since `sinceMs`, newest first, plus how many there
 *  were in all (the list is capped; the count isn't). Includes kills still
 *  waiting for the next flush. */
export async function killsInSystems(systemIds: number[], sinceMs: number, limit: number): Promise<{ kills: StoredKill[]; total: number }> {
  if (systemIds.length === 0) return { kills: [], total: 0 };
  const since = new Date(sinceMs);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query<Row>(
      `SELECT * FROM recent_kills WHERE eve_system_id = ANY($1::int[]) AND killed_at >= $2
        ORDER BY killed_at DESC, killmail_id DESC LIMIT $3`, [systemIds, since, limit]),
    db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM recent_kills WHERE eve_system_id = ANY($1::int[]) AND killed_at >= $2`, [systemIds, since]),
  ]);
  const want = new Set(systemIds);
  const have = new Set(rows.map((r) => Number(r.killmail_id)));
  const fresh = pending.filter((k) => want.has(k.eveSystemId) && k.atMs >= sinceMs && !have.has(k.killmailId));
  const kills = [...fresh, ...rows.map(fromRow)].sort((a, b) => b.atMs - a.atMs).slice(0, limit);
  return { kills, total: Number(countRows[0]?.n ?? 0) + fresh.length };
}

export function startKillStore(): void {
  setInterval(() => { flushKills().catch((err) => log.warn('flush failed:', err)); }, FLUSH_MS).unref();
  const prune = () => {
    pruneKills()
      .then((n) => { if (n > 0) log.info(`pruned ${n} kill(s) older than ${KILL_STORE_DAYS}d`); })
      .catch((err) => log.warn('prune failed:', err));
  };
  prune();
  setInterval(prune, PRUNE_MS).unref();
}

/** Exposed for tests. */
export function clearPendingKills(): void {
  pending.length = 0;
}
