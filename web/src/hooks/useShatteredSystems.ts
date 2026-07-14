import { useEffect, useState } from 'react';
import { createStaticResource } from './createStaticResource';

export interface ShatteredSystem {
  id:         number;
  name:       string;
  regionName: string;
}

// The shattered list is static cluster data — load once per page, never refresh.
const { useResource, load } = createStaticResource<ShatteredSystem[]>('/api/systems/shattered', []);
export const useShatteredSystems = useResource;

// Shared Set of shattered eve-ids for O(1) membership, derived ONCE globally
// from the loaded list rather than rebuilt in every map node. The Set is
// populated in an effect (via the resource's own load()), never reassigned
// during render — the react-hooks purity rule forbids mutating module state
// while rendering. A stable empty Set is used until the data loads.
const EMPTY_IDS: ReadonlySet<number> = new Set();
let idSetCache: Set<number> | null = null;

export function useShatteredSystemIds(): ReadonlySet<number> {
  const [ids, setIds] = useState<ReadonlySet<number>>(idSetCache ?? EMPTY_IDS);
  useEffect(() => {
    let cancelled = false;
    load().then((list) => {
      if (!idSetCache) idSetCache = new Set(list.map((s) => s.id));
      if (!cancelled) setIds(idSetCache);
    });
    return () => { cancelled = true; };
  }, []);
  return ids;
}
