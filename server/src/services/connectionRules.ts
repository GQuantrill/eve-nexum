import { db } from '../db.js';
import { TtlValue } from '../utils/cache.js';

/**
 * What a connection type is allowed to claim, checked against the SDE.
 *
 * The map lets you set a connection's jump type by hand, and nothing stopped it
 * disagreeing with the game: a "gate" between two wormhole systems (reported
 * from the field, and found in live data), or between two k-space systems that
 * aren't actually neighbours. Both mislead routing and the chain view.
 *
 * The rules, all derived from map_stargates rather than guessed from class
 * strings — a system with stargates is k-space, a pair joined by one are
 * neighbours:
 *
 *   gate      — the two systems must be stargate neighbours in EVE
 *   jumpgate  — both ends k-space (an Ansiblex is a nullsec structure)
 *   cyno      — both ends k-space (a cyno can't be lit in wormhole space)
 *   standard  — always allowed; a wormhole can join anything to anything
 *
 * Deliberately permissive where it can't know: an endpoint with no eve_system_id
 * (a custom node, or an unmapped-wormhole placeholder) is unverifiable and
 * passes, and so does everything if map_stargates hasn't been seeded — the same
 * way the create route's gate auto-classifier already degrades.
 */

export interface EndpointEveIds {
  sourceEveId: number | null;
  targetEveId: number | null;
}

// map_stargates only changes on an SDE re-seed, so the "is it populated at all"
// answer is worth holding briefly rather than asking on every write.
const seeded = new TtlValue<boolean>(5 * 60_000);

async function stargatesSeeded(): Promise<boolean> {
  const hit = seeded.get();
  if (hit !== null) return hit;
  try {
    const { rowCount } = await db.query(`SELECT 1 FROM map_stargates LIMIT 1`);
    const populated = (rowCount ?? 0) > 0;
    seeded.set(populated);
    return populated;
  } catch {
    return false; // table absent → can't validate → allow
  }
}

/** The endpoints' EVE ids for an existing connection (null when unresolved). */
export async function connectionEndpointEveIds(
  mapId: string, connectionId: string,
): Promise<EndpointEveIds | null> {
  const { rows } = await db.query<{ src: number | null; tgt: number | null }>(
    `SELECT s.eve_system_id AS src, t.eve_system_id AS tgt
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
      WHERE c.id = $1 AND c.map_id = $2`,
    [connectionId, mapId],
  );
  if (!rows.length) return null;
  return { sourceEveId: rows[0].src, targetEveId: rows[0].tgt };
}

/** The endpoints' EVE ids for two map_systems rows (used on create). */
export async function systemEveIds(sourceId: string, targetId: string): Promise<EndpointEveIds> {
  const { rows } = await db.query<{ id: string; eve: number | null }>(
    `SELECT id, eve_system_id AS eve FROM map_systems WHERE id = ANY($1::uuid[])`,
    [[sourceId, targetId]],
  );
  const byId = new Map(rows.map((r) => [r.id, r.eve]));
  return { sourceEveId: byId.get(sourceId) ?? null, targetEveId: byId.get(targetId) ?? null };
}

/**
 * null when the type is allowed, else a human-readable reason for a 400.
 */
export async function connectionTypeError(
  connectionType: string, ep: EndpointEveIds,
): Promise<string | null> {
  if (connectionType !== 'gate' && connectionType !== 'jumpgate' && connectionType !== 'cyno') {
    return null;
  }
  const { sourceEveId, targetEveId } = ep;
  if (sourceEveId == null || targetEveId == null) return null;  // unresolved endpoint
  if (!(await stargatesSeeded())) return null;                  // no SDE to check against

  if (connectionType === 'gate') {
    const { rowCount } = await db.query(
      `SELECT 1 FROM map_stargates
        WHERE (system_id = $1 AND destination_system_id = $2)
           OR (system_id = $2 AND destination_system_id = $1)
        LIMIT 1`,
      [sourceEveId, targetEveId],
    );
    return (rowCount ?? 0) > 0
      ? null
      : 'A stargate connection needs two systems that are stargate neighbours in EVE';
  }

  // jumpgate / cyno: both ends must be k-space, i.e. have stargates of their own.
  const { rows } = await db.query<{ id: number }>(
    `SELECT DISTINCT system_id AS id FROM map_stargates WHERE system_id = ANY($1::int[])`,
    [[sourceEveId, targetEveId]],
  );
  const kspace = new Set(rows.map((r) => r.id));
  if (kspace.has(sourceEveId) && kspace.has(targetEveId)) return null;
  return connectionType === 'cyno'
    ? 'A cynosural field cannot be lit in wormhole space'
    : 'An Ansiblex jump bridge can only link k-space systems';
}
