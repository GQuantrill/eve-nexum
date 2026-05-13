import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface A0System {
  id:         number;
  name:       string;
  regionName: string;
}

// The A0 list is static cluster data — load once per page, never refresh.
let cache: A0System[] | null = null;
let inflight: Promise<A0System[]> | null = null;
const EMPTY: A0System[] = [];

function load(): Promise<A0System[]> {
  if (cache)    return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api<A0System[]>('/api/systems/a0')
    .then(rows => {
      cache = rows;
      inflight = null;
      return cache;
    })
    .catch(() => {
      inflight = null;
      return cache ?? EMPTY;
    });
  return inflight;
}

export function useA0Systems(): A0System[] {
  const [data, setData] = useState<A0System[]>(cache ?? EMPTY);

  useEffect(() => {
    if (cache) { setData(cache); return; }
    let cancelled = false;
    load().then(s => { if (!cancelled) setData(s); });
    return () => { cancelled = true; };
  }, []);

  return data;
}
