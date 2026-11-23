// Chain numbers ("L+1"), when a map turns them on. Every system gets a number
// that is its path from home: the holes out of home are 1, 2, 3 in the order
// they are first jumped, the holes out of 5 are 51, 52, and out of 516 are
// 5161, 5162. The number goes in front of the hole's bookmark name ({chain}),
// so the bookmarks sort into chain order in the EVE client.
//
// - A number is handed out once, on the first jump into a system, and never
//   changes or comes round again (map_chain_counters): pilots' in-game
//   bookmarks still carry it after the hole is gone.
// - Past 9 a dot separates the parts, so a tenth hole is never mistaken for a
//   deeper one: the tenth hole out of 5 is 5.10, and its holes 5.10.1 and on.
//   From home, the tenth is .10.
// - Only a jump out of home, or out of a numbered system, numbers anything.
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

/**
 * Number `toId` as the next hole out of `fromId`, if the map numbers chains,
 * `toId` has no number and isn't home, and `fromId` is home or numbered.
 * Returns the system's number afterwards (null if it has none).
 */
export async function assignChainNumber(mapId: string, fromId: string, toId: string): Promise<string | null> {
  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
    // The arriving system's row, locked: two pilots jumping in at once get one number.
    const { rows } = await client.query<{ id: string; isHome: boolean; label: string | null; on: boolean }>(
      `SELECT s.id, s.is_home AS "isHome", s.chain_label AS label, m.chain_numbering AS "on"
         FROM map_systems s JOIN maps m ON m.id = s.map_id
        WHERE s.map_id = $1 AND s.id = ANY($2::uuid[])
        ORDER BY s.id FOR UPDATE OF s`, [mapId, [fromId, toId]]);
    const to = rows.find((r) => r.id === toId);
    const from = rows.find((r) => r.id === fromId);
    if (!to || !from || !to.on || to.isHome || to.label) { await client.query('COMMIT'); return to?.label ?? null; }
    const parent = from.isHome ? '' : from.label;
    if (parent == null) { await client.query('COMMIT'); return null; }

    // Never below a number already on the map (one set by hand, say).
    const { rows: kids } = await client.query<{ label: string }>(
      `SELECT chain_label AS label FROM map_systems
        WHERE map_id = $1 AND chain_label IS NOT NULL AND left(chain_label, length($2)) = $2`, [mapId, parent]);
    const highest = Math.max(0, ...kids.map((k) => childIndex(parent, k.label) ?? 0));
    const { rows: [counter] } = await client.query<{ n: number }>(
      `INSERT INTO map_chain_counters (map_id, parent, last_index) VALUES ($1, $2, $3)
       ON CONFLICT (map_id, parent) DO UPDATE
         SET last_index = GREATEST(map_chain_counters.last_index + 1, EXCLUDED.last_index)
       RETURNING last_index AS n`, [mapId, parent, highest + 1]);
    const label = childLabel(parent, counter.n);
    if (label.length > MAX_CHAIN_LABEL_LEN) { await client.query('ROLLBACK'); return null; }
    await client.query(`UPDATE map_systems SET chain_label = $1 WHERE id = $2`, [label, toId]);
    await client.query('COMMIT');
    return label;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
