import { useEffect, useState } from 'react';
import { createStaticResource } from './createStaticResource';

// Eve system id -> names of the OTHER regions its stargates lead to. Only
// border systems appear (~670 cluster-wide). Static SDE data.
type RegionBorders = Record<number, string[]>;

const EMPTY: RegionBorders = {};
const { load, peek } = createStaticResource<RegionBorders>('/api/systems/region-borders', EMPTY);

/** Region-border lookup, fetched only once something asks for it with
 *  `enabled` -- the label is opt-in, so pilots who never turn it on never pay
 *  for the request. Loaded once per page and shared by every node. */
export function useRegionBorders(enabled: boolean): RegionBorders {
  const [data, setData] = useState<RegionBorders>(() => peek() ?? EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load().then((d) => { if (!cancelled) setData(d); });
    return () => { cancelled = true; };
  }, [enabled]);

  // peek() first: another node may have finished the load since this one's
  // state was seeded, and there's no reason to wait a tick to show it.
  return enabled ? (peek() ?? data) : EMPTY;
}
