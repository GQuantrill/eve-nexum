// In-memory jump-route pathfinding over the LS/NS star map. Jump drives only work
// in low/null (never highsec or wormhole space), so the graph is every LS/NS
// system with SDE coordinates. A hop is legal when the star-to-star distance is
// within the ship's max range; neighbours are computed on the fly from the cached
// coordinates (no precomputed edge table needed — ~5.4k systems fit in memory and
// A* keeps expansions cheap). Ship-agnostic: callers pass rangeLy + objective.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('jumpGraph');
const METRES_PER_LY = 9.4607e15;

interface JumpSystem { id: number; name: string; cls: string; x: number; y: number; z: number; x2: number; y2: number }

let systems: JumpSystem[] | null = null;
let byId: Map<number, JumpSystem> | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (systems) return;
  if (loading) { await loading; return; }
  loading = (async () => {
    const { rows } = await db.query<{ id: number; name: string; class: string; pos_x: number; pos_y: number; pos_z: number; pos2d_x: number | null; pos2d_y: number | null }>(
      `SELECT id, name, class, pos_x, pos_y, pos_z, pos2d_x, pos2d_y
         FROM solar_systems
        WHERE class IN ('LS','NS') AND pos_x IS NOT NULL`,
    );
    // pos2d is CCP's flat star-map projection (for the route map); fall back to the
    // galactic X/Z plane if a row is missing it so layout never breaks.
    systems = rows.map((r) => ({
      id: r.id, name: r.name, cls: r.class, x: r.pos_x, y: r.pos_y, z: r.pos_z,
      x2: r.pos2d_x ?? r.pos_x, y2: r.pos2d_y ?? r.pos_z,
    }));
    byId = new Map(systems.map((s) => [s.id, s]));
    log.info(`loaded ${systems.length} LS/NS systems for jump routing`);
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

export interface JumpRouteHop { eveSystemId: number; name: string; systemClass: string; lyFromPrev: number; x: number; y: number }
export interface JumpRouteResult { hops: JumpRouteHop[]; jumps: number; totalLy: number }

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

/**
 * Shortest jump route from `fromId` to `toId` where every hop is <= `rangeLy`.
 * objective 'hops' minimises jump count; 'fuel' minimises total light-years
 * (fuel is proportional to ly for a given ship). Returns null if either endpoint
 * isn't a coord'd LS/NS system, or no route exists within range. A* with a
 * straight-line-to-goal heuristic (admissible for both objectives).
 */
export async function planJumpRoute(
  fromId: number, toId: number, rangeLy: number, objective: 'hops' | 'fuel',
): Promise<JumpRouteResult | null> {
  await ensureLoaded();
  const src = byId!.get(fromId);
  const dst = byId!.get(toId);
  if (!src || !dst) return null;
  if (fromId === toId) return { hops: [{ eveSystemId: fromId, name: src.name, systemClass: src.cls, lyFromPrev: 0, x: src.x2, y: src.y2 }], jumps: 0, totalLy: 0 };

  const all = systems!;
  const g = new Map<number, number>();       // best cost from source
  const prev = new Map<number, number>();
  const done = new Set<number>();
  const heur = (s: JumpSystem) => (objective === 'fuel' ? lyBetween(s, dst) : lyBetween(s, dst) / rangeLy);

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
      const ly = lyBetween(cs, n);
      if (ly > rangeLy) continue;
      const ng = gc + (objective === 'fuel' ? ly : 1);
      if (ng < (g.get(n.id) ?? Infinity)) {
        g.set(n.id, ng);
        prev.set(n.id, cur);
        heap.push(ng + heur(n), n.id);
      }
    }
  }

  if (!prev.has(toId)) return null;                     // unreachable within range
  const path: number[] = [];
  for (let c: number | undefined = toId; c != null; c = prev.get(c)) path.unshift(c);

  const hops: JumpRouteHop[] = [];
  let totalLy = 0;
  for (let i = 0; i < path.length; i++) {
    const s = byId!.get(path[i])!;
    const ly = i === 0 ? 0 : lyBetween(byId!.get(path[i - 1])!, s);
    totalLy += ly;
    hops.push({ eveSystemId: s.id, name: s.name, systemClass: s.cls, lyFromPrev: ly, x: s.x2, y: s.y2 });
  }
  return { hops, jumps: path.length - 1, totalLy };
}

/** Reset the cache (call after an SDE re-import so new coords are picked up). */
export function resetJumpGraph(): void { systems = null; byId = null; loading = null; }
