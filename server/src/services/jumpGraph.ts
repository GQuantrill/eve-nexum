// In-memory jump-route pathfinding over the LS/NS star map. Jump drives only work
// in low/null (never highsec, wormhole, or Pochven/Triglavian space — Niarja &
// co. read LS/NS by security but can't be jumped through), so the graph is every
// LS/NS system with SDE coordinates that ISN'T in Pochven. A hop is legal when
// the star-to-star distance is
// within the ship's max range; neighbours are computed on the fly from the cached
// coordinates (no precomputed edge table needed — ~5.4k systems fit in memory and
// A* keeps expansions cheap). Ship-agnostic: callers pass rangeLy + objective.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('jumpGraph');
const METRES_PER_LY = 9.4607e15;

interface JumpSystem { id: number; name: string; cls: string; x: number; y: number; z: number; x2: number; y2: number; safe: boolean }

let systems: JumpSystem[] | null = null;
let byId: Map<number, JumpSystem> | null = null;
// Regional-gate edges: system id -> ids of jump-graph systems reachable in one
// stargate jump that crosses a region boundary (e.g. Atioth -> K-IYNW). A capital
// can take these instead of jumping around, so when the caller opts in they act
// as 1-hop, no-range, no-fuel edges. Opt-in only (these gates are chokepoints and
// can be camped). Only pairs where BOTH endpoints are in the graph are kept.
let gateEdges: Map<number, number[]> | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (systems) return;
  if (loading) { await loading; return; }
  loading = (async () => {
    const { rows } = await db.query<{ id: number; name: string; class: string; pos_x: number; pos_y: number; pos_z: number; pos2d_x: number | null; pos2d_y: number | null }>(
      `SELECT s.id, s.name, s.class, s.pos_x, s.pos_y, s.pos_z, s.pos2d_x, s.pos2d_y
         FROM solar_systems s
         LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.class IN ('LS','NS') AND s.pos_x IS NOT NULL
          -- Pochven (Triglavian space) can't be jumped to/through; its systems
          -- read LS/NS by security but must be excluded from the jump graph.
          AND r.name IS DISTINCT FROM 'Pochven'`,
    );
    // "Safe" = has an NPC station (a place to dock/tether). Used by the
    // prefer-station-systems option so routes avoid landing in empty systems.
    // npc_stations may be empty until backfilled — then nothing is safe and the
    // option simply has no effect.
    const stationRows = await db.query<{ solar_system_id: number }>(
      `SELECT DISTINCT solar_system_id FROM npc_stations WHERE solar_system_id IS NOT NULL`,
    ).catch(() => ({ rows: [] as { solar_system_id: number }[] }));
    const stationSet = new Set(stationRows.rows.map((r) => r.solar_system_id));
    // pos2d is CCP's flat star-map projection (for the route map); fall back to the
    // galactic X/Z plane if a row is missing it so layout never breaks.
    systems = rows.map((r) => ({
      id: r.id, name: r.name, cls: r.class, x: r.pos_x, y: r.pos_y, z: r.pos_z,
      x2: r.pos2d_x ?? r.pos_x, y2: r.pos2d_y ?? r.pos_z, safe: stationSet.has(r.id),
    }));
    byId = new Map(systems.map((s) => [s.id, s]));

    // Regional gates: stargate connections whose two endpoints sit in different
    // regions. These are the long "regional gate" jumps a capital takes to cross
    // into another region rather than making many jump-drive hops around. Keep
    // only edges where both ends are jump-graph systems (excludes highsec /
    // Pochven ends a capital can't gate through anyway).
    const idSet = byId;
    const gateRows = await db.query<{ a: number; b: number }>(
      `SELECT g.system_id AS a, g.destination_system_id AS b
         FROM map_stargates g
         JOIN solar_systems sa ON sa.id = g.system_id
         JOIN solar_systems sb ON sb.id = g.destination_system_id
        WHERE sa.region_id IS DISTINCT FROM sb.region_id`,
    ).catch(() => ({ rows: [] as { a: number; b: number }[] }));
    gateEdges = new Map();
    let gateCount = 0;
    for (const { a, b } of gateRows.rows) {
      if (!idSet.has(a) || !idSet.has(b)) continue;   // one end outside the jump graph
      const list = gateEdges.get(a);
      if (list) list.push(b); else gateEdges.set(a, [b]);
      gateCount++;
    }
    log.info(`loaded ${systems.length} LS/NS systems for jump routing (${stationSet.size} with stations, ${gateCount} regional-gate edges)`);
  })();
  await loading;
}

/** Systems in memory yet? (0 = coords not backfilled — same gate as jump-range). */
export async function jumpGraphSize(): Promise<number> {
  await ensureLoaded();
  return systems?.length ?? 0;
}

const lyBetween = (a: JumpSystem, b: JumpSystem): number =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2) / METRES_PER_LY;

export interface JumpRouteHop { eveSystemId: number; name: string; systemClass: string; lyFromPrev: number; x: number; y: number; viaGate?: boolean }
// jumps = jump-drive activations (fatigue); gates = regional-gate jumps (no
// fatigue/fuel); totalLy = jump-drive light-years only (gates burn no jump fuel).
export interface JumpRouteResult { hops: JumpRouteHop[]; jumps: number; gates: number; totalLy: number }

// Minimal binary min-heap keyed by priority (f-score).
class MinHeap {
  private a: Array<{ p: number; id: number }> = [];
  get size() { return this.a.length; }
  push(p: number, id: number) {
    const a = this.a; a.push({ p, id });
    let i = a.length - 1;
    while (i > 0) { const par = (i - 1) >> 1; if (a[par].p <= a[i].p) break; [a[par], a[i]] = [a[i], a[par]]; i = par; }
  }
  pop(): number {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].p < a[m].p) m = l;
        if (r < a.length && a[r].p < a[m].p) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top.id;
  }
}

// Prefer-station-systems bias: virtual cost added to a hop that lands in an
// "unsafe" (no station/structure) intermediate system. Two UI-selectable tiers;
// soft — the router still routes through empties when it must. 'hops'/'ly' are
// the penalty in each objective's units. Tune these if a tier feels off.
const PREFER_PENALTY = {
  prefer: { hops: 2, ly: 1.5 },   // gentle nudge
  strong: { hops: 5, ly: 4 },     // hug station systems hard
} as const;
export type PreferLevel = keyof typeof PREFER_PENALTY;

export interface PlanOpts {
  /** Systems the route must never pass through (endpoints are exempt). */
  avoid?: Set<number>;
  /** Bias strength toward station/structure systems; undefined = no bias. */
  preferSafe?: PreferLevel;
  /** Extra "safe" systems beyond NPC stations — e.g. the caller's structures. */
  extraSafe?: Set<number>;
  /** Allow regional (cross-region) stargate jumps as 1-hop, no-range edges.
   *  Opt-in: these gates are chokepoints and can be camped. */
  regionalGates?: boolean;
}

/**
 * Shortest jump route from `fromId` to `toId` where every hop is <= `rangeLy`.
 * objective 'hops' minimises jump count; 'fuel' minimises total light-years
 * (fuel is proportional to ly for a given ship). `opts.avoid` routes around
 * given systems; `opts.preferSafe` biases toward station/structure systems.
 * Returns null if either endpoint isn't a coord'd LS/NS system, or no route
 * exists within range. A* with a straight-line-to-goal heuristic (admissible:
 * the penalty only ever adds cost, so the heuristic never overestimates).
 */
export async function planJumpRoute(
  fromId: number, toId: number, rangeLy: number, objective: 'hops' | 'fuel', opts: PlanOpts = {},
): Promise<JumpRouteResult | null> {
  await ensureLoaded();
  const src = byId!.get(fromId);
  const dst = byId!.get(toId);
  if (!src || !dst) return null;
  if (fromId === toId) return { hops: [{ eveSystemId: fromId, name: src.name, systemClass: src.cls, lyFromPrev: 0, x: src.x2, y: src.y2 }], jumps: 0, gates: 0, totalLy: 0 };

  const avoid = opts.avoid ?? new Set<number>();
  const extraSafe = opts.extraSafe;
  const isSafe = (s: JumpSystem) => s.safe || (extraSafe?.has(s.id) ?? false);
  const pen = opts.preferSafe ? PREFER_PENALTY[opts.preferSafe] : null;
  const penalty = pen ? (objective === 'fuel' ? pen.ly : pen.hops) : 0;
  const useGates = !!opts.regionalGates;
  const gEdges = gateEdges!;

  const all = systems!;
  const g = new Map<number, number>();       // best cost from source
  const prev = new Map<number, number>();
  const viaGate = new Map<number, boolean>(); // was the edge INTO this node a regional gate?
  const done = new Set<number>();
  // A regional gate crosses far more than one jump-range in a single hop, so the
  // straight-line heuristic would overestimate the remaining cost and break A*'s
  // optimality. Fall back to Dijkstra (h = 0) whenever gates are in play.
  const heur = useGates
    ? (_s: JumpSystem) => 0
    : (s: JumpSystem) => (objective === 'fuel' ? lyBetween(s, dst) : lyBetween(s, dst) / rangeLy);

  const heap = new MinHeap();
  g.set(fromId, 0);
  heap.push(heur(src), fromId);

  while (heap.size) {
    const cur = heap.pop();
    if (cur === toId) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const cs = byId!.get(cur)!;
    const gc = g.get(cur)!;
    for (const n of all) {
      if (n.id === cur || done.has(n.id)) continue;
      if (avoid.has(n.id) && n.id !== toId) continue;   // route around avoided systems
      const ly = lyBetween(cs, n);
      if (ly > rangeLy) continue;
      // Penalise landing in an empty system (not the destination) when asked.
      const extra = (pen && n.id !== toId && !isSafe(n)) ? penalty : 0;
      const ng = gc + (objective === 'fuel' ? ly : 1) + extra;
      if (ng < (g.get(n.id) ?? Infinity)) {
        g.set(n.id, ng);
        prev.set(n.id, cur);
        viaGate.set(n.id, false);
        heap.push(ng + heur(n), n.id);
      }
    }
    // Regional-gate edges (opt-in): a single stargate jump across a region
    // boundary — 1 hop, no fuel, no range limit. The prefer-safe penalty still
    // applies to landing in an empty system.
    if (useGates) {
      const gates = gEdges.get(cur);
      if (gates) {
        for (const nid of gates) {
          if (done.has(nid)) continue;
          if (avoid.has(nid) && nid !== toId) continue;
          const n = byId!.get(nid);
          if (!n) continue;
          const extra = (pen && nid !== toId && !isSafe(n)) ? penalty : 0;
          const ng = gc + (objective === 'fuel' ? 0 : 1) + extra;
          if (ng < (g.get(nid) ?? Infinity)) {
            g.set(nid, ng);
            prev.set(nid, cur);
            viaGate.set(nid, true);
            heap.push(ng + heur(n), nid);
          }
        }
      }
    }
  }

  if (!prev.has(toId)) return null;                     // unreachable within range
  const path: number[] = [];
  for (let c: number | undefined = toId; c != null; c = prev.get(c)) path.unshift(c);

  const hops: JumpRouteHop[] = [];
  let totalLy = 0;
  let gates = 0;
  for (let i = 0; i < path.length; i++) {
    const s = byId!.get(path[i])!;
    const gate = i > 0 && viaGate.get(path[i]) === true;
    const ly = i === 0 ? 0 : lyBetween(byId!.get(path[i - 1])!, s);
    // A gate hop covers real distance but burns no jump fuel, so it doesn't add
    // to the light-year total; the physical span is still reported on the hop.
    if (gate) gates++; else totalLy += ly;
    hops.push({ eveSystemId: s.id, name: s.name, systemClass: s.cls, lyFromPrev: ly, x: s.x2, y: s.y2, viaGate: gate });
  }
  return { hops, jumps: path.length - 1 - gates, totalLy, gates };
}

/**
 * Route through an ordered list of systems `[from, ...waypoints, to]`, planning
 * each consecutive leg and stitching them into one route. Returns null if any
 * leg is unreachable within range. The shared junction system between legs is
 * de-duplicated, so jumps/totalLy stay correct across the whole path.
 */
export async function planJumpRouteVia(
  waypoints: number[], rangeLy: number, objective: 'hops' | 'fuel', opts: PlanOpts = {},
): Promise<JumpRouteResult | null> {
  if (waypoints.length < 2) return null;
  const legs: JumpRouteResult[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = await planJumpRoute(waypoints[i], waypoints[i + 1], rangeLy, objective, opts);
    if (!leg) return null;                 // one unreachable leg => no route
    legs.push(leg);
  }
  const hops: JumpRouteHop[] = [...legs[0].hops];
  let jumps = legs[0].jumps, gates = legs[0].gates, totalLy = legs[0].totalLy;
  for (let i = 1; i < legs.length; i++) {
    hops.push(...legs[i].hops.slice(1));   // drop the junction shared with the prior leg
    jumps += legs[i].jumps;
    gates += legs[i].gates;
    totalLy += legs[i].totalLy;
  }
  return { hops, jumps, gates, totalLy };
}

/** Reset the cache (call after an SDE re-import so new coords are picked up). */
export function resetJumpGraph(): void { systems = null; byId = null; gateEdges = null; loading = null; }
