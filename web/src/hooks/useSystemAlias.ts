import { useMemo } from 'react';
import { useMapStore } from '../store/mapStore';

/**
 * Returns a resolver `(realName) => alias || realName` for display sites that
 * only have a system's real NAME string (route hops, closest/scout lists, live
 * location, pickers) rather than the MapSystem object. Looks the name up against
 * the current map's aliases so an aliased system reads consistently everywhere.
 *
 * Display-only: never feed the result back into routing/ESI or a stored value —
 * pass the real name to those. Memoised on the systems array (stable until
 * systems change); maps are small.
 */
export function useSystemAlias(): (realName: string | null | undefined) => string {
  const systems = useMapStore((s) => s.map.systems);
  const aliasByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of systems) {
      const a = s.alias?.trim();
      if (a) m.set(s.name, a);
    }
    return m;
  }, [systems]);
  return (realName) => (realName ? aliasByName.get(realName) ?? realName : (realName ?? ''));
}
