import { db } from '../db.js';
import { getScoutConnections } from '../routes/scout.js';
import { edgeKey, type RouteOverlay, type EdgeMeta } from './routeGraph.js';
import { effectiveExpiryMs, MAX_WH_LIFETIME_HOURS } from '../data/whLifetimes.js';

// Thera/Turnur solar-system ids, resolved once by name from the SDE-seeded
// solar_systems table (both are ordinary rows there) and cached for the process.
let hubIds: { thera: number | null; turnur: number | null } | null = null;
async function getHubIds(): Promise<{ thera: number | null; turnur: number | null }> {
  if (hubIds) return hubIds;
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM solar_systems WHERE name IN ('Thera', 'Turnur')`,
  );
  hubIds = {
    thera:  rows.find(r => r.name === 'Thera')?.id  ?? null,
    turnur: rows.find(r => r.name === 'Turnur')?.id ?? null,
  };
  return hubIds;
}

function emptyOverlay(): RouteOverlay {
  return { adj: new Map(), info: new Map(), edgeMeta: new Map() };
}

// A wormhole/scout link is one logical edge; add it in BOTH directions to match
// the base stargate graph (which stores reverse twins as separate rows).
function addEdge(o: RouteOverlay, a: number, b: number, meta: EdgeMeta): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    let list = o.adj.get(x);
    if (!list) { list = []; o.adj.set(x, list); }
    list.push(y);
    o.edgeMeta.set(edgeKey(x, y), meta);
  }
}

// Thera/Turnur scout connections. Each connection touches its hub on one end and
// a (usually k-space) exit on the other; add both if the hub is enabled.
async function addScoutEdges(o: RouteOverlay, thera: boolean, turnur: boolean, expired: Set<string>): Promise<boolean> {
  const { thera: theraId, turnur: turnurId } = await getHubIds();
  const conns = await getScoutConnections();
  let added = false;
  for (const c of conns) {
    // Flagged collapsed by this requester's scope — routing through it would
    // send them to a hole that isn't there.
    if (expired.has(c.id)) continue;
    const isThera  = theraId  != null && (c.outSystemId === theraId  || c.inSystemId === theraId);
    const isTurnur = turnurId != null && (c.outSystemId === turnurId || c.inSystemId === turnurId);
    if (isThera  && !thera)  continue;
    if (isTurnur && !turnur) continue;
    if (!isThera && !isTurnur) continue;
    addEdge(o, c.outSystemId, c.inSystemId, {
      kind:   isThera ? 'thera' : 'turnur',
      whType: c.whType || undefined,
      eol:    c.remainingHours <= 4,
      frig:   /frig/i.test(c.maxShipSize),
    });
    added = true;
  }
  return added;
}

// Wormhole chain links from one or more maps. Only real wormholes
// (connection_type 'standard'; gates already live in the base graph), never
// broken/collapsed holes, and only where both ends have a resolved
// eve_system_id — an unmapped intermediate system with a null id necessarily
// severs that chain path. Passing several map ids unions their chains (the
// closest-systems pane routes across every map the user can see, so the chain
// they're actually sitting in is used regardless of the active tab).
async function addWormholeEdges(o: RouteOverlay, mapIds: string[]): Promise<boolean> {
  if (mapIds.length === 0) return false;
  const { rows } = await db.query<{
    a: number; b: number; whType: string | null;
    critical: boolean; eol: boolean; frig: boolean; mapName: string;
    lifetimeExpiresAt: Date | null; eolAt: Date | null; createdAt: Date; graceHours: number;
  }>(
    `SELECT s.eve_system_id AS a, t.eve_system_id AS b,
            c.wh_type AS "whType",
            (c.mass_status = 'critical') AS critical,
            (c.time_status = 'eol' OR (c.eol_at IS NOT NULL AND c.eol_at <= NOW())) AS eol,
            (c.size = 'small') AS frig,
            m.name AS "mapName",
            c.lifetime_expires_at AS "lifetimeExpiresAt",
            c.eol_at              AS "eolAt",
            c.created_at          AS "createdAt",
            m.collapse_grace_hours AS "graceHours"
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
       JOIN maps m ON m.id = c.map_id
      WHERE c.map_id = ANY($1::uuid[])
        AND c.broken = FALSE
        AND c.connection_type = 'standard'
        AND s.eve_system_id IS NOT NULL
        AND t.eve_system_id IS NOT NULL`,
    [mapIds],
  );
  const now = Date.now();
  let added = 0;
  for (const r of rows) {
    if (isPastLife(r, now)) continue;
    added++;
    addEdge(o, r.a, r.b, {
      kind: 'wormhole',
      whType: r.whType || undefined,
      critical: r.critical,
      eol: r.eol,
      frig: r.frig,
      mapName: r.mapName,
    });
  }
  return added > 0;
}

/**
 * True when a hole is far enough past its collapse that routing through it
 * would send someone to a gap.
 *
 * Deliberately the SAME threshold the lifetime sweep uses to sever a hole
 * (expiry + the map's collapse grace) and computed with the SAME shared
 * helper, so routing and the map never disagree about whether one is dead.
 * The difference is that this applies everywhere: the sweep only severs on
 * maps with lazy_remove_wormholes on, which defaults off, so on an ordinary
 * map a long-dead hole keeps its row and used to keep routing.
 *
 * An UNTYPED hole still has a knowable ceiling. No wormhole in EVE outlives
 * MAX_WH_LIFETIME_HOURS, which is already how a K162 — equally typeless, for
 * the same reason — is aged. So one older than that cannot be open whatever it
 * turned out to be, and routing through it is simply wrong. Below the ceiling
 * it is left alone, which keeps a freshly hand-drawn chain intact.
 *
 * Note this only declines to USE the edge. Deleting an untyped connection is a
 * separate, destructive decision and stays with the sweep, which still skips
 * them.
 */
export function isPastLife(
  r: { lifetimeExpiresAt: Date | null; eolAt: Date | null; whType: string | null;
       createdAt: Date; graceHours: number },
  now: number,
): boolean {
  const expiry = effectiveExpiryMs(r)
    ?? new Date(r.createdAt).getTime() + MAX_WH_LIFETIME_HOURS * 3_600_000;
  return now > expiry + r.graceHours * 3_600_000;
}

// Player Ansiblex jump bridges known on the map (connection_type 'jumpgate').
// Both ends are k-space, so every route node stays autopilot-able per-node —
// but EVE's autopilot won't route through a bridge on its own, so an Ansiblex
// route is still flagged usesSpecial like a wormhole.
async function addAnsiblexEdges(o: RouteOverlay, mapIds: string[]): Promise<boolean> {
  if (mapIds.length === 0) return false;
  const { rows } = await db.query<{ a: number; b: number; mapName: string }>(
    `SELECT s.eve_system_id AS a, t.eve_system_id AS b, m.name AS "mapName"
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
       JOIN maps m ON m.id = c.map_id
      WHERE c.map_id = ANY($1::uuid[])
        AND c.broken = FALSE
        AND c.connection_type = 'jumpgate'
        AND s.eve_system_id IS NOT NULL
        AND t.eve_system_id IS NOT NULL`,
    [mapIds],
  );
  // A bridge is standing infrastructure, so no lifetime filter applies.
  for (const r of rows) addEdge(o, r.a, r.b, { kind: 'ansiblex', mapName: r.mapName });
  return rows.length > 0;
}

// Fill { name, security } for every overlay node from solar_systems, so the
// secure-mode weight and the response path have real data for J-space / Thera.
async function fillInfo(o: RouteOverlay): Promise<void> {
  const ids = [...o.adj.keys()];
  if (ids.length === 0) return;
  const { rows } = await db.query<{ id: number; name: string; security: string }>(
    `SELECT id, name, security::text AS security FROM solar_systems WHERE id = ANY($1::int[])`,
    [ids],
  );
  for (const r of rows) o.info.set(r.id, { name: r.name, security: Number(r.security) });
}

/**
 * Build the per-request routing overlay from the enabled shortcut sources.
 * Returns `undefined` when nothing was enabled or no edges were produced, so
 * the caller passes `undefined` to shortestRoutes and routing is unchanged.
 * The caller MUST authorize every id in `mapIds` (getMapAccess, or derive them
 * from listVisibleMaps which is already access-scoped) before enabling wormholes.
 */
export async function buildRouteOverlay(opts: {
  thera: boolean; turnur: boolean; wormholes: boolean; ansiblex: boolean; mapIds?: string[];
  /** Scout connections the requester has flagged collapsed; never routed through. */
  expiredScout?: Set<string>;
}): Promise<RouteOverlay | undefined> {
  const o = emptyOverlay();
  const mapIds = opts.mapIds ?? [];
  const expired = opts.expiredScout ?? new Set<string>();
  let any = false;
  if (opts.thera || opts.turnur) any = (await addScoutEdges(o, opts.thera, opts.turnur, expired)) || any;
  if (opts.wormholes && mapIds.length) any = (await addWormholeEdges(o, mapIds)) || any;
  if (opts.ansiblex && mapIds.length)  any = (await addAnsiblexEdges(o, mapIds)) || any;
  if (!any) return undefined;
  await fillInfo(o);
  return o;
}
