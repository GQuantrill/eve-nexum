import { db } from '../db.js';
import { getScoutConnections } from '../routes/scout.js';
import { edgeKey, type RouteOverlay, type EdgeMeta } from './routeGraph.js';

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
async function addScoutEdges(o: RouteOverlay, thera: boolean, turnur: boolean): Promise<boolean> {
  const { thera: theraId, turnur: turnurId } = await getHubIds();
  const conns = await getScoutConnections();
  let added = false;
  for (const c of conns) {
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

// Wormhole chain links from a map. Only real wormholes (connection_type
// 'standard'; gates already live in the base graph), never broken/collapsed
// holes, and only where both ends have a resolved eve_system_id — an unmapped
// intermediate system with a null id necessarily severs that chain path.
async function addWormholeEdges(o: RouteOverlay, mapId: string): Promise<boolean> {
  const { rows } = await db.query<{
    a: number; b: number; whType: string | null;
    critical: boolean; eol: boolean; frig: boolean;
  }>(
    `SELECT s.eve_system_id AS a, t.eve_system_id AS b,
            c.wh_type AS "whType",
            (c.mass_status = 'critical') AS critical,
            (c.time_status = 'eol' OR (c.eol_at IS NOT NULL AND c.eol_at <= NOW())) AS eol,
            (c.size = 'small') AS frig
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
      WHERE c.map_id = $1
        AND c.broken = FALSE
        AND c.connection_type = 'standard'
        AND s.eve_system_id IS NOT NULL
        AND t.eve_system_id IS NOT NULL`,
    [mapId],
  );
  for (const r of rows) {
    addEdge(o, r.a, r.b, {
      kind: 'wormhole',
      whType: r.whType || undefined,
      critical: r.critical,
      eol: r.eol,
      frig: r.frig,
    });
  }
  return rows.length > 0;
}

// Player Ansiblex jump bridges known on the map (connection_type 'jumpgate').
// Both ends are k-space, so every route node stays autopilot-able per-node —
// but EVE's autopilot won't route through a bridge on its own, so an Ansiblex
// route is still flagged usesSpecial like a wormhole.
async function addAnsiblexEdges(o: RouteOverlay, mapId: string): Promise<boolean> {
  const { rows } = await db.query<{ a: number; b: number }>(
    `SELECT s.eve_system_id AS a, t.eve_system_id AS b
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
      WHERE c.map_id = $1
        AND c.broken = FALSE
        AND c.connection_type = 'jumpgate'
        AND s.eve_system_id IS NOT NULL
        AND t.eve_system_id IS NOT NULL`,
    [mapId],
  );
  for (const r of rows) addEdge(o, r.a, r.b, { kind: 'ansiblex' });
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
 * The caller MUST authorize `mapId` (getMapAccess) before enabling wormholes.
 */
export async function buildRouteOverlay(opts: {
  thera: boolean; turnur: boolean; wormholes: boolean; ansiblex: boolean; mapId?: string;
}): Promise<RouteOverlay | undefined> {
  const o = emptyOverlay();
  let any = false;
  if (opts.thera || opts.turnur) any = (await addScoutEdges(o, opts.thera, opts.turnur)) || any;
  if (opts.wormholes && opts.mapId) any = (await addWormholeEdges(o, opts.mapId)) || any;
  if (opts.ansiblex && opts.mapId)  any = (await addAnsiblexEdges(o, opts.mapId)) || any;
  if (!any) return undefined;
  await fillInfo(o);
  return o;
}
