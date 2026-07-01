import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routeGraph');

// Metadata for a non-stargate ("special") edge spliced into the graph — a
// wormhole chain link or a Thera/Turnur scout connection. Carried through to
// the client so the route UI can mark the gap and flag risky holes.
export interface EdgeMeta {
  kind:      'wormhole' | 'thera' | 'turnur';
  eol?:      boolean;   // end-of-life hole
  critical?: boolean;   // critical mass
  frig?:     boolean;   // frigate-sized hole
  whType?:   string;    // wormhole type code, when known
}

// A per-request overlay of extra edges (+ their node info + edge metadata)
// merged on top of the static stargate graph. Never mutates the base graph.
export interface RouteOverlay {
  adj:      Map<number, number[]>;
  info:     Map<number, { name: string; security: number }>;
  edgeMeta: Map<string, EdgeMeta>;   // key = `${a}|${b}`, added both directions
}

export function edgeKey(a: number, b: number): string { return `${a}|${b}`; }

export interface RoutePathNode {
  id:       number;
  name:     string;
  security: number;
  kspace:   boolean;    // true when in the base stargate graph (autopilot-able)
  via?:     EdgeMeta;   // set when the hop INTO this node was a special edge
}

export interface RouteEntry {
  jumps:       number;
  path:        RoutePathNode[];
  usesSpecial: boolean;  // path traverses at least one wormhole/Thera/Turnur hop
}

export type RouteMode = 'shortest' | 'secure';

// Penalty weights for the secure mode. EVE's in-game route planner uses
// similar tiering — high-sec hops are free, low-sec is expensive, null-sec
// is essentially "only if you have to". Numbers are large enough that no
// reasonable HS detour will ever lose to a single LS/NS shortcut.
const SECURE_WEIGHTS = { hs: 1, ls: 100, ns: 10_000 } as const;
function edgeCost(toSecurity: number, mode: RouteMode, isSpecial: boolean): number {
  if (mode === 'shortest') return 1;
  // Shortcuts (wormhole / Thera / Turnur) count as null-sec in secure mode, so
  // a "secure" route only dives through one when there's no k-space path.
  if (isSpecial) return SECURE_WEIGHTS.ns;
  if (toSecurity >= 0.45) return SECURE_WEIGHTS.hs;
  if (toSecurity >  0.00) return SECURE_WEIGHTS.ls;
  return SECURE_WEIGHTS.ns;
}

// System IDs that exist in the SDE stargate graph but aren't routable in-game
// (special-access systems requiring filaments / non-public mechanics). Edges
// to or from these systems are dropped at graph-build time so BFS won't use
// them as shortcuts.
const BLACKLISTED_SYSTEMS = new Set<number>([
  30100000, // Zarzakh — Triglavian neutral hub, filament-only entry
]);

let adjacency:  Map<number, number[]>                          | null = null;
let systemInfo: Map<number, { name: string; security: number }> | null = null;

/**
 * Build the in-memory stargate adjacency list from map_stargates, and load
 * { name, security } for every system that participates in the graph.
 * Called once at server startup.
 */
export async function loadRouteGraph(): Promise<void> {
  const [adjRows, sysRows] = await Promise.all([
    db.query<{ system_id: number; destination_system_id: number }>(
      `SELECT system_id, destination_system_id FROM map_stargates`,
    ),
    db.query<{ id: number; name: string; security: string }>(
      `SELECT id, name, security::text AS security
         FROM solar_systems
        WHERE id IN (SELECT DISTINCT system_id FROM map_stargates)`,
    ),
  ]);

  const adj = new Map<number, number[]>();
  let skipped = 0;
  for (const r of adjRows.rows) {
    if (BLACKLISTED_SYSTEMS.has(r.system_id) || BLACKLISTED_SYSTEMS.has(r.destination_system_id)) {
      skipped++;
      continue;
    }
    let list = adj.get(r.system_id);
    if (!list) { list = []; adj.set(r.system_id, list); }
    list.push(r.destination_system_id);
  }

  const info = new Map<number, { name: string; security: number }>();
  for (const r of sysRows.rows) {
    info.set(r.id, { name: r.name, security: Number(r.security) });
  }

  adjacency  = adj;
  systemInfo = info;
  log.info(`Loaded ${adj.size} systems, ${adjRows.rows.length - skipped} stargate edges (${skipped} blacklisted)`);
}

/**
 * Compute shortest paths from `source` to every reachable target.
 *
 *   mode='shortest'  → plain BFS, every hop costs 1.
 *   mode='secure'    → Dijkstra with security-tiered edge weights so the
 *                      route prefers HS, detours through LS only when it
 *                      has to, and avoids NS unless there's no alternative.
 *
 * `jumps` in the returned RouteEntry is always the literal hop count of
 * the path, not the weighted cost — that's what users care about and it
 * keeps the response shape stable across modes.
 */
export async function shortestRoutes(
  source: number,
  targets: number[],
  mode: RouteMode = 'shortest',
  overlay?: RouteOverlay,
): Promise<Record<number, RouteEntry>> {
  if (!adjacency || !systemInfo) throw new Error('Route graph not loaded');
  const baseAdj  = adjacency;
  const baseInfo = systemInfo;

  const hasNode = (n: number): boolean => baseAdj.has(n) || (overlay?.info.has(n) ?? false);
  if (!hasNode(source)) return {};

  const targetSet = new Set(targets.filter(hasNode));
  if (targetSet.size === 0) return {};

  // Neighbours come from the static stargate graph plus any per-request overlay
  // edges; the base graph is never copied or mutated.
  const neighborsOf = (node: number): number[] =>
    overlay ? [...(baseAdj.get(node) ?? []), ...(overlay.adj.get(node) ?? [])]
            : (baseAdj.get(node) ?? []);
  const infoOf = (id: number) => overlay?.info.get(id) ?? baseInfo.get(id);
  const isSpecialEdge = (a: number, b: number): boolean =>
    overlay ? overlay.edgeMeta.has(edgeKey(a, b)) : false;

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  dist.set(source, 0);
  const found = new Set<number>();

  if (mode === 'shortest') {
    // Plain BFS — cheaper than Dijkstra for uniform-weight graphs.
    const queue: number[] = [source];
    let head = 0;
    while (head < queue.length && found.size < targetSet.size) {
      const node = queue[head++];
      if (targetSet.has(node)) {
        found.add(node);
        if (found.size === targetSet.size) break;
      }
      const neighbors = neighborsOf(node);
      if (neighbors.length === 0) continue;
      const d = dist.get(node)!;
      for (const n of neighbors) {
        if (!dist.has(n)) {
          dist.set(n, d + 1);
          prev.set(n, node);
          queue.push(n);
        }
      }
    }
  } else {
    // Dijkstra with a binary min-heap. ~8k node graph, ~40k edges total
    // — runs in well under a millisecond per source.
    const heap = new MinHeap();
    heap.push(source, 0);
    while (!heap.empty() && found.size < targetSet.size) {
      const { id: node, cost } = heap.pop()!;
      if (cost > (dist.get(node) ?? Infinity)) continue; // stale entry
      if (targetSet.has(node)) {
        found.add(node);
        if (found.size === targetSet.size) break;
      }
      const neighbors = neighborsOf(node);
      if (neighbors.length === 0) continue;
      for (const n of neighbors) {
        const w = edgeCost(infoOf(n)?.security ?? 0, 'secure', isSpecialEdge(node, n));
        const newCost = cost + w;
        if (newCost < (dist.get(n) ?? Infinity)) {
          dist.set(n, newCost);
          prev.set(n, node);
          heap.push(n, newCost);
        }
      }
    }
  }

  const result: Record<number, RouteEntry> = {};
  for (const t of found) {
    const ids: number[] = [];
    let cur: number | undefined = t;
    while (cur !== undefined) {
      ids.push(cur);
      if (cur === source) break;
      cur = prev.get(cur);
    }
    ids.reverse();

    let usesSpecial = false;
    const path: RoutePathNode[] = ids.map((id, i) => {
      const info = infoOf(id);
      const via = i > 0 ? overlay?.edgeMeta.get(edgeKey(ids[i - 1], id)) : undefined;
      if (via) usesSpecial = true;
      return {
        id,
        name:     info?.name ?? '?',
        security: info?.security ?? 0,
        kspace:   baseInfo.has(id),
        ...(via ? { via } : {}),
      };
    });

    result[t] = { jumps: ids.length - 1, path, usesSpecial };
  }

  return result;
}

// Tiny binary heap keyed by cost. Sufficient for Dijkstra over the
// EVE stargate graph (~8k nodes); a Fibonacci heap is overkill.
class MinHeap {
  private a: Array<{ id: number; cost: number }> = [];
  empty() { return this.a.length === 0; }
  push(id: number, cost: number) {
    this.a.push({ id, cost });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].cost <= this.a[i].cost) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): { id: number; cost: number } | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < n && this.a[l].cost < this.a[smallest].cost) smallest = l;
        if (r < n && this.a[r].cost < this.a[smallest].cost) smallest = r;
        if (smallest === i) break;
        [this.a[smallest], this.a[i]] = [this.a[i], this.a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
