// What kind of kill a killmail was, as short tags the killboard shows: on a
// gate, with a heavy interdictor or interdictor on the mail, a smartbomb kill,
// solo, or an NPC kill. Worked out here from numeric ids (zKill's locationID,
// each attacker's ship and weapon type) against the SDE, so the client never
// has to trust a label someone else wrote.
import { db } from '../db.js';

export type KillTag = 'gate' | 'hic' | 'dic' | 'sb' | 'solo' | 'npc';

// SDE ids. zKill's locationID is the celestial nearest the kill; item ids in
// this range are stargates (stations are 60M+, other celestials 40M+).
const STARGATE_MIN = 50_000_000;
const STARGATE_MAX = 60_000_000;
const GROUP_HIC = 894;       // Heavy Interdiction Cruiser
const GROUP_DIC = 541;       // Interdictor
const GROUP_SMARTBOMB = 72;  // Smart Bomb (module)

export interface TagInput {
  locationId?: number | null;
  solo?: boolean;
  npc?: boolean;
  /** Attackers' ship and weapon type ids. */
  typeIds: number[];
}

/** Tags for one kill, given each type id's SDE group. Order is fixed so the
 *  chips line up from kill to kill. */
export function tagsFor(k: TagInput, groupOf: (typeId: number) => number | null | undefined): KillTag[] {
  const tags: KillTag[] = [];
  const loc = Number(k.locationId);
  if (Number.isFinite(loc) && loc >= STARGATE_MIN && loc < STARGATE_MAX) tags.push('gate');
  const groups = new Set(k.typeIds.map(groupOf));
  if (groups.has(GROUP_HIC)) tags.push('hic');
  if (groups.has(GROUP_DIC)) tags.push('dic');
  if (groups.has(GROUP_SMARTBOMB)) tags.push('sb');
  if (k.solo) tags.push('solo');
  if (k.npc) tags.push('npc');
  return tags;
}

// Type id -> group id. The SDE doesn't change between imports, so this only
// ever grows towards the few thousand ship and weapon types that turn up on
// killmails; the cap is a backstop.
const groupCache = new Map<number, number | null>();
const GROUP_CACHE_MAX = 50_000;

/** Look up any type ids not already known, then return a lookup function. */
export async function loadGroups(typeIds: Iterable<number>): Promise<(typeId: number) => number | null | undefined> {
  const missing = [...new Set(typeIds)].filter((id) => Number.isInteger(id) && id > 0 && !groupCache.has(id));
  if (missing.length > 0) {
    try {
      const { rows } = await db.query<{ id: number; group_id: number }>(
        `SELECT id, group_id FROM item_types WHERE id = ANY($1::int[])`, [missing]);
      if (groupCache.size + missing.length > GROUP_CACHE_MAX) groupCache.clear();
      const found = new Map(rows.map((r) => [r.id, r.group_id]));
      for (const id of missing) groupCache.set(id, found.get(id) ?? null);
    } catch {
      // No SDE (a fresh install): kills just go untagged for ship-based tags.
    }
  }
  return (id) => groupCache.get(id);
}

/** Attackers' ship + weapon type ids from an ESI-shaped attacker list. */
export function attackerTypeIds(attackers: Array<{ ship_type_id?: number; weapon_type_id?: number }> | undefined): number[] {
  const out = new Set<number>();
  for (const a of attackers ?? []) {
    const s = Number(a?.ship_type_id); if (s > 0) out.add(s);
    const w = Number(a?.weapon_type_id); if (w > 0) out.add(w);
  }
  return [...out];
}
