import { useMemo } from 'react';
import { useMapStore } from '../store/mapStore';
import type { SystemClass } from '../types';

/**
 * UPPERCASE system name -> its class, for resolving a wormhole's "leads to" when
 * it's pinned to a specific connected system (e.g. a K162 solved to "Arnon", a
 * Hi-Sec system). The watchlist "leads to" match uses this so a resolved hole
 * counts as leading to that system's class — a local lookup, no per-match scan.
 *
 * Memoised on the systems array, which useMapStore keeps referentially stable
 * until the systems actually change; a wormhole map's system count is small, so
 * rebuilding the map on a change is cheap even with many callers.
 */
export function useSystemClassByName(): Map<string, SystemClass> {
  const systems = useMapStore((s) => s.map.systems);
  return useMemo(() => {
    const m = new Map<string, SystemClass>();
    for (const s of systems) if (s.name) m.set(s.name.trim().toUpperCase(), s.systemClass);
    return m;
  }, [systems]);
}
