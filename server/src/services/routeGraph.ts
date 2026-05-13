import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routeGraph');

export interface RouteEntry {
  jumps: number;
  path:  Array<{ id: number; name: string; security: number }>;
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
 * BFS from `source` to every reachable system, returning jump count + path
 * for the subset of `targets` that are reachable.
 */
export function shortestRoutes(source: number, targets: number[]): Record<number, RouteEntry> {
  if (!adjacency || !systemInfo) throw new Error('Route graph not loaded');
  if (!adjacency.has(source)) return {};

  const targetSet = new Set(targets.filter(t => adjacency!.has(t)));
  if (targetSet.size === 0) return {};

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  dist.set(source, 0);
  const queue: number[] = [source];
  let head = 0;
  const found = new Set<number>();

  while (head < queue.length && found.size < targetSet.size) {
    const node = queue[head++];
    if (targetSet.has(node)) {
      found.add(node);
      if (found.size === targetSet.size) break;
    }
    const neighbors = adjacency.get(node);
    if (!neighbors) continue;
    const d = dist.get(node)!;
    for (const n of neighbors) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        prev.set(n, node);
        queue.push(n);
      }
    }
  }

  const result: Record<number, RouteEntry> = {};
  for (const t of found) {
    const path: number[] = [];
    let cur: number | undefined = t;
    while (cur !== undefined) {
      path.push(cur);
      if (cur === source) break;
      cur = prev.get(cur);
    }
    path.reverse();
    result[t] = {
      jumps: dist.get(t)!,
      path:  path.map(id => {
        const info = systemInfo!.get(id);
        return { id, name: info?.name ?? '?', security: info?.security ?? 0 };
      }),
    };
  }

  return result;
}
