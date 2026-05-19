import { useEffect, useState } from 'react';
import { api } from '../api/client';

// Static cluster data — load once per page, never refresh.
let cache: Set<number> | null = null;
let inflight: Promise<Set<number>> | null = null;
const EMPTY: Set<number> = new Set();

function load(): Promise<Set<number>> {
  if (cache)    return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api<number[]>('/api/systems/ice-belts')
    .then((ids) => {
      cache = new Set(ids);
      inflight = null;
      return cache;
    })
    .catch(() => {
      inflight = null;
      return cache ?? EMPTY;
    });
  return inflight;
}

export function useIceBeltSystems(): Set<number> {
  const [data, setData] = useState<Set<number>>(cache ?? EMPTY);

  useEffect(() => {
    if (cache) { setData(cache); return; }
    let cancelled = false;
    load().then((s) => { if (!cancelled) setData(s); });
    return () => { cancelled = true; };
  }, []);

  return data;
}

export function hasIceBelt(set: Set<number>, eveSystemId: number | null): boolean {
  return !!eveSystemId && set.has(eveSystemId);
}
