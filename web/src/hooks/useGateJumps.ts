import { useEffect, useMemo } from 'react';
import { useMapStore } from '../store/mapStore';
import { useGateJumpsStore } from '../store/gateJumpsStore';
import { useRouteOrigin } from './useRouteOrigin';
import { useRoute } from './useRoute';

const K_SPACE = new Set(['HS', 'LS', 'NS']);

/**
 * Compute gate-jump counts from the route origin to every on-map k-space system
 * and publish them to the gate-jumps store (for the per-node "jumps from X"
 * hover). One /api/route call = one single-source BFS covering all targets, so
 * it only re-runs when the origin or the on-map k-space set changes; hovering a
 * node is then a plain store lookup. Wormhole systems have no gates, so they're
 * excluded and simply show nothing. Call once at the map level.
 */
export function useGateJumps(): void {
  const origin   = useRouteOrigin();
  const systems  = useMapStore((s) => s.map.systems);
  const setJumps = useGateJumpsStore((s) => s.setJumps);

  const targets = useMemo(
    () => [...new Set(
      systems
        .filter((s) => s.eveSystemId != null && K_SPACE.has(s.systemClass))
        .map((s) => s.eveSystemId as number),
    )],
    [systems],
  );

  const routes = useRoute(origin.systemId, targets, 'active');

  useEffect(() => {
    const m = new Map<number, number>();
    for (const [id, entry] of Object.entries(routes)) m.set(Number(id), entry.jumps);
    setJumps(m, origin.systemId, origin.name);
  }, [routes, origin.systemId, origin.name, setJumps]);
}
