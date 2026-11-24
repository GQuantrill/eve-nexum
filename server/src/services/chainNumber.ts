// Chain numbers ("L+1"), when a map turns them on. Every system gets a number
// that is its path from home: the holes out of home are 1, 2, 3 in the order
// they are first jumped, the holes out of 5 are 51, 52, and out of 516 are
// 5161, 5162. The number goes in front of the hole's bookmark name ({chain}),
// so the bookmarks sort into chain order in the EVE client.
//
// - A number is handed out on the first jump into a system and never changes
//   while the system is on the map. The lowest free number goes first: once a
//   system and any reservation with that number are gone, it is free again,
//   so a static rolled every day stays 1.
// - Past 9 a dot separates the parts, so a tenth hole is never mistaken for a
//   deeper one: the tenth hole out of 5 is 5.10, and its holes 5.10.1 and on.
//   From home, the tenth is .10.
// - Only a jump out of home, or out of a numbered system, numbers anything.
// - A scout can reserve numbers on the wormhole signatures of home or a
//   numbered system before anyone jumps them (reserveChainNumbers). The system
//   a reserved hole leads to takes that number when it is jumped. Reservations
//   hold their number like a system does, live 48 hours, and go with their
//   signature.
import type { PoolClient } from 'pg';
import { db } from '../db.js';

/** The parts of a label: one digit each until the first dot, then dot-separated. */
export function labelParts(label: string): number[] {
  const dot = label.indexOf('.');
  const head = dot === -1 ? label : label.slice(0, dot);
  const tail = dot === -1 ? [] : label.slice(dot + 1).split('.');
  return [...head.split('').map(Number), ...tail.map(Number)];
}

/** The label of the `index`th hole out of `parent` ('' = home). */
export function childLabel(parent: string, index: number): string {
  return index >= 10 || parent.includes('.') ? `${parent}.${index}` : `${parent}${index}`;
}

/** The index of `label` if it is a hole straight out of `parent`, else null. */
export function childIndex(parent: string, label: string): number | null {
  const p = labelParts(parent === '' ? '' : parent);
  const c = labelParts(label);
  if (c.length !== (parent === '' ? 0 : p.length) + 1) return null;
  const last = c[c.length - 1];
  return childLabel(parent, last) === label ? last : null;
}

/** A label a pilot may set by hand: digits, dots between parts past 9. */
export const CHAIN_LABEL_RE = /^(?=[.1-9])[1-9]*(\.[1-9][0-9]{0,2})*$/;
export const MAX_CHAIN_LABEL_LEN = 40;

/** How long a reserved number waits for its hole to be jumped. */
export const RESERVATION_HOURS = 48;

/** SQL: signature alias `s` holds a reservation that is still live. */
const LIVE = `s.chain_label IS NOT NULL AND s.chain_reserved_at > NOW() - interval '${RESERVATION_HOURS} hours'`;

/**
 * The lowest index out of `parent` that nothing on the map holds: no system
 * and no live reservation has that number. A hole that dies or is cleared
 * gives its number back, so a static rolled every day stays 1. Systems left
 * behind it don't hold it (with 1 gone, 11 is cut off), and they can't clash:
 * a hole out of the new 1 skips the 11 still on the map. The counter row is only
 * a lock, so two pilots numbering at once get different numbers. Run inside a
 * transaction.
 */
async function nextIndex(client: PoolClient, mapId: string, parent: string): Promise<number> {
  await client.query(
    `INSERT INTO map_chain_counters (map_id, parent, last_index) VALUES ($1, $2, 0)
     ON CONFLICT (map_id, parent) DO NOTHING`, [mapId, parent]);
  await client.query(
    `SELECT 1 FROM map_chain_counters WHERE map_id = $1 AND parent = $2 FOR UPDATE`, [mapId, parent]);
  const { rows: kids } = await client.query<{ label: string }>(
    `SELECT chain_label AS label FROM map_systems
      WHERE map_id = $1 AND chain_label IS NOT NULL AND left(chain_label, length($2)) = $2
     UNION ALL
     SELECT s.chain_label FROM map_signatures s JOIN map_systems y ON y.id = s.system_id
      WHERE y.map_id = $1 AND ${LIVE} AND left(s.chain_label, length($2)) = $2`,
    [mapId, parent]);
  const used = new Set(kids.map((k) => childIndex(parent, k.label)).filter((i): i is number => i != null));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Is `label` already some system's number on this map? */
async function labelTaken(client: PoolClient, mapId: string, label: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM map_systems WHERE map_id = $1 AND chain_label = $2`, [mapId, label]);
  return !!rowCount;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ChainNumberResult {
  /** The system's number afterwards (null if it has none). */
  label: string | null;
  /** Not numbered yet: the system jumped from has reserved holes, and which
   *  one was jumped isn't known. Ask again with `settle` once it is. */
  deferred: boolean;
}

/**
 * Number `toId` as a hole out of `fromId`, if the map numbers chains, `toId`
 * has no number and isn't home, and `fromId` is home or numbered.
 *
 * - A reserved signature in `fromId` that leads to `toId`: its number.
 * - Else, when `fromId` has live reservations and `settle` is false: nothing
 *   yet (deferred), so a reserved number isn't skipped past.
 * - Else the lowest free number.
 */
export async function assignChainNumber(
  mapId: string, fromId: string, toId: string, settle = false,
): Promise<ChainNumberResult> {
  return withClient(async (client) => {
    // Both rows, locked: two pilots jumping in at once get one number.
    const { rows } = await client.query<{ id: string; name: string; isHome: boolean; label: string | null; on: boolean }>(
      `SELECT s.id, s.name, s.is_home AS "isHome", s.chain_label AS label, m.chain_numbering AS "on"
         FROM map_systems s JOIN maps m ON m.id = s.map_id
        WHERE s.map_id = $1 AND s.id = ANY($2::uuid[])
        ORDER BY s.id FOR UPDATE OF s`, [mapId, [fromId, toId]]);
    const to = rows.find((r) => r.id === toId);
    const from = rows.find((r) => r.id === fromId);
    const none = { label: to?.label ?? null, deferred: false };
    if (!to || !from || !to.on || to.isHome || to.label) return none;
    const parent = from.isHome ? '' : from.label;
    if (parent == null) return none;

    const { rows: sigs } = await client.query<{ label: string; leadsTo: string }>(
      `SELECT s.chain_label AS label, upper(trim(s.wh_leads_to)) AS "leadsTo"
         FROM map_signatures s WHERE s.system_id = $1 AND ${LIVE}
        ORDER BY s.chain_reserved_at FOR UPDATE OF s`, [fromId]);
    // Only a reservation made under this parent's current number counts.
    const mine = sigs.filter((r) => childIndex(parent, r.label) != null);
    const reserved = mine.find((r) => r.leadsTo && r.leadsTo === to.name.trim().toUpperCase());
    if (reserved && !(await labelTaken(client, mapId, reserved.label))) {
      await client.query(`UPDATE map_systems SET chain_label = $1 WHERE id = $2`, [reserved.label, toId]);
      return { label: reserved.label, deferred: false };
    }
    if (!settle) {
      const open = [];
      for (const r of mine) if (!(await labelTaken(client, mapId, r.label))) open.push(r);
      if (open.length) return { label: null, deferred: true };
    }

    const label = childLabel(parent, await nextIndex(client, mapId, parent));
    if (label.length > MAX_CHAIN_LABEL_LEN) throw new LabelTooLong();
    await client.query(`UPDATE map_systems SET chain_label = $1 WHERE id = $2`, [label, toId]);
    return { label, deferred: false };
  }).catch((err) => {
    if (err instanceof LabelTooLong) return { label: null, deferred: false };
    throw err;
  });
}

class LabelTooLong extends Error {}

export interface Reserved {
  /** The signature row's id. */
  id: string;
  chainLabel: string;
  /** A system the hole already leads to that took the number now, if any. */
  systemId?: string;
}

/**
 * Reserve chain numbers on wormhole signatures of `systemId`, in the order
 * given. Signatures that already hold a live number keep it (and are
 * returned); ones that can't take a number are skipped:
 * - the system must be home or numbered, on a map that numbers chains;
 * - the signature must be a wormhole that doesn't lead to home or to a system
 *   that already has a number.
 * A hole whose far system is already on the map without a number gives that
 * system the number straight away.
 */
export async function reserveChainNumbers(mapId: string, systemId: string, sigIds: string[]): Promise<Reserved[]> {
  return withClient(async (client) => {
    const { rows: [sys] } = await client.query<{ isHome: boolean; label: string | null; on: boolean }>(
      `SELECT s.is_home AS "isHome", s.chain_label AS label, m.chain_numbering AS "on"
         FROM map_systems s JOIN maps m ON m.id = s.map_id
        WHERE s.map_id = $1 AND s.id = $2 FOR UPDATE OF s`, [mapId, systemId]);
    if (!sys || !sys.on) return [];
    const parent = sys.isHome ? '' : sys.label;
    if (parent == null) return [];

    const { rows: sigs } = await client.query<{ id: string; type: string; leadsTo: string; label: string | null; live: boolean }>(
      `SELECT s.id, s.sig_type AS type, upper(trim(s.wh_leads_to)) AS "leadsTo", s.chain_label AS label,
              (${LIVE}) AS live
         FROM map_signatures s WHERE s.system_id = $1 AND s.id = ANY($2::uuid[])
        ORDER BY s.id FOR UPDATE OF s`, [systemId, sigIds]);
    const byId = new Map(sigs.map((r) => [r.id, r]));
    const out: Reserved[] = [];
    for (const id of sigIds) {
      const sig = byId.get(id);
      if (!sig || sig.type !== 'wormhole') continue;
      if (sig.live && sig.label && childIndex(parent, sig.label) != null) {
        out.push({ id, chainLabel: sig.label }); continue;
      }
      let far: { id: string; isHome: boolean; label: string | null } | undefined;
      if (sig.leadsTo) {
        ({ rows: [far] } = await client.query<{ id: string; isHome: boolean; label: string | null }>(
          `SELECT id, is_home AS "isHome", chain_label AS label FROM map_systems
            WHERE map_id = $1 AND upper(trim(name)) = $2 LIMIT 1`, [mapId, sig.leadsTo]));
        if (far && (far.isHome || far.label)) continue; // home, or already numbered
      }
      const label = childLabel(parent, await nextIndex(client, mapId, parent));
      if (label.length > MAX_CHAIN_LABEL_LEN) break;
      await client.query(
        `UPDATE map_signatures SET chain_label = $1, chain_reserved_at = NOW() WHERE id = $2`, [label, id]);
      // Only if nobody numbered it meanwhile (a jump landing at the same moment).
      const took = far
        ? (await client.query(`UPDATE map_systems SET chain_label = $1 WHERE id = $2 AND chain_label IS NULL`, [label, far.id])).rowCount
        : 0;
      out.push({ id, chainLabel: label, ...(took && far ? { systemId: far.id } : {}) });
    }
    return out;
  });
}

/**
 * Clear a reservation on a signature, while no system has taken its number.
 * The number is free again. True if one was cleared.
 */
export async function clearChainReservation(mapId: string, systemId: string, sigRowId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE map_signatures s SET chain_label = NULL, chain_reserved_at = NULL
      WHERE s.id = $1 AND s.system_id = $2 AND s.chain_label IS NOT NULL
        AND s.system_id IN (SELECT id FROM map_systems WHERE map_id = $3)
        AND NOT EXISTS (SELECT 1 FROM map_systems y WHERE y.map_id = $3 AND y.chain_label = s.chain_label)`,
    [sigRowId, systemId, mapId]);
  return !!rowCount;
}

/**
 * A reserved signature now says where it leads (set by hand, or matched after
 * a jump): give that system the number if it has none. Returns the system's
 * id when it was numbered.
 */
export async function claimReservedNumber(mapId: string, systemId: string, sigRowId: string): Promise<{ id: string; label: string } | null> {
  return withClient(async (client) => {
    const { rows: [sig] } = await client.query<{ label: string; leadsTo: string; isHome: boolean; parent: string | null }>(
      `SELECT s.chain_label AS label, upper(trim(s.wh_leads_to)) AS "leadsTo",
              y.is_home AS "isHome", y.chain_label AS parent
         FROM map_signatures s JOIN map_systems y ON y.id = s.system_id
        WHERE s.id = $1 AND s.system_id = $2 AND y.map_id = $3 AND ${LIVE}`, [sigRowId, systemId, mapId]);
    if (!sig || !sig.leadsTo) return null;
    const parent = sig.isHome ? '' : sig.parent;
    if (parent == null || childIndex(parent, sig.label) == null) return null;
    const { rows: [far] } = await client.query<{ id: string }>(
      `SELECT y.id FROM map_systems y JOIN maps m ON m.id = y.map_id
        WHERE y.map_id = $1 AND upper(trim(y.name)) = $2 AND NOT y.is_home AND y.chain_label IS NULL
          AND m.chain_numbering LIMIT 1 FOR UPDATE OF y`, [mapId, sig.leadsTo]);
    if (!far || (await labelTaken(client, mapId, sig.label))) return null;
    await client.query(`UPDATE map_systems SET chain_label = $1 WHERE id = $2`, [sig.label, far.id]);
    return { id: far.id, label: sig.label };
  });
}

/**
 * A system's own number was changed by hand: reservations on its signatures
 * were made under the old number, so drop the ones that no longer fit and no
 * system has taken. True if any were dropped.
 */
export async function dropStaleReservations(mapId: string, systemId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string; label: string; isHome: boolean; parent: string | null }>(
    `SELECT s.id, s.chain_label AS label, y.is_home AS "isHome", y.chain_label AS parent
       FROM map_signatures s JOIN map_systems y ON y.id = s.system_id
      WHERE s.system_id = $1 AND y.map_id = $2 AND s.chain_label IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM map_systems z WHERE z.map_id = $2 AND z.chain_label = s.chain_label)`,
    [systemId, mapId]);
  const stale = rows.filter((r) => {
    const parent = r.isHome ? '' : r.parent;
    return parent == null || childIndex(parent, r.label) == null;
  }).map((r) => r.id);
  if (!stale.length) return false;
  await db.query(
    `UPDATE map_signatures SET chain_label = NULL, chain_reserved_at = NULL WHERE id = ANY($1::uuid[])`, [stale]);
  return true;
}

/** Clear reservations past their 48 hours, everywhere. Best-effort tidy-up:
 *  reads already ignore them. */
export async function clearExpiredReservations(): Promise<void> {
  await db.query(
    `UPDATE map_signatures SET chain_label = NULL, chain_reserved_at = NULL
      WHERE chain_label IS NOT NULL
        AND (chain_reserved_at IS NULL OR chain_reserved_at <= NOW() - interval '${RESERVATION_HOURS} hours')`);
}
