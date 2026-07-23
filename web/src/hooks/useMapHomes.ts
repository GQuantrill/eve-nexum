import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';

// A home system flagged on one of the user's maps, resolved to an EVE id so it
// can be routed to. Deduped across every map the user can see.
export interface MapHome { eveSystemId: number; name: string }

/**
 * The home systems flagged across ALL the maps the user can see — not just the
 * active tab. Powers the Closest Systems pane's auto-home rows, which are a
 * per-user list and must not change when the active map does. The active map's
 * live home is merged in on top of the fetched set, so toggling it on this tab
 * reflects immediately (the fetch reflects committed DB state).
 *
 * Refetched when the map set changes (a map added/removed) or the active map's
 * own home is toggled — the two events that alter the answer in-session. A home
 * toggled on a *non-active* map surfaces on the next such change or reload,
 * which is fine for an auto-suggested convenience row.
 */
export function useAllMapHomes(): MapHome[] {
  const [fetched, setFetched] = useState<MapHome[]>([]);

  // Cheap primitives to key the refetch on: the set of visible map ids, and the
  // active map's current home (so setting/unsetting it here refreshes too).
  const mapIdsKey = useMapStore(useShallow((s) => s.maps.map((m) => m.id).sort().join(',')));
  const activeHome = useMapStore(useShallow((s) => {
    const found = s.map.systems.find((sys) => sys.isHome && sys.eveSystemId != null);
    return found ? { eveSystemId: found.eveSystemId as number, name: found.name } : null;
  }));
  const activeHomeId = activeHome?.eveSystemId ?? null;

  useEffect(() => {
    let cancelled = false;
    api<{ homes: MapHome[] }>('/api/maps/homes')
      .then((r) => { if (!cancelled) setFetched(Array.isArray(r.homes) ? r.homes : []); })
      .catch(() => { if (!cancelled) setFetched([]); });
    return () => { cancelled = true; };
  }, [mapIdsKey, activeHomeId]);

  return useMemo(() => {
    const byId = new Map<number, MapHome>();
    for (const h of fetched) byId.set(h.eveSystemId, h);
    if (activeHome) byId.set(activeHome.eveSystemId, activeHome);
    return [...byId.values()];
  }, [fetched, activeHome]);
}
