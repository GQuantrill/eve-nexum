import type { RouteEntry } from '../hooks/useRoute';

interface SysLite  { id: string; eveSystemId: number | null }
interface ConnLite { id: string; sourceId: string; targetId: string }

/**
 * The parts of a route that are on this map, for highlighting it there: each
 * map system on the path, and each map connection joining two systems that
 * are next to each other on it (a mapped hole or gate the route uses). A
 * route mostly through k-space touches the map only at its ends, which is
 * still worth showing. Null when none of it is on the map.
 */
export function routeMapHighlight(
  route: RouteEntry, systems: SysLite[], connections: ConnLite[],
): { systemIds: string[]; connectionIds: string[] } | null {
  const byEve = new Map<number, string[]>();
  for (const s of systems) {
    if (s.eveSystemId == null) continue;
    const list = byEve.get(s.eveSystemId);
    if (list) list.push(s.id); else byEve.set(s.eveSystemId, [s.id]);
  }
  const systemIds = route.path.flatMap((n) => byEve.get(n.id) ?? []);
  if (systemIds.length === 0) return null;

  const eveOf = new Map(systems.map((s) => [s.id, s.eveSystemId]));
  const hops = new Set<string>();
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1].id, b = route.path[i].id;
    hops.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  const connectionIds = connections.filter((c) => {
    const a = eveOf.get(c.sourceId), b = eveOf.get(c.targetId);
    if (a == null || b == null) return false;
    return hops.has(a < b ? `${a}|${b}` : `${b}|${a}`);
  }).map((c) => c.id);

  return { systemIds, connectionIds };
}
