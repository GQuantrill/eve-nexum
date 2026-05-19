import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type StormType = 'electric' | 'gamma' | 'exotic' | 'plasma' | 'unknown';

export interface StormSystem {
  eveSystemId:    number | null;
  systemName:     string;
  regionName:     string;
  stormName:      string;
  stormType:      StormType;
  lastReport:     string;
  hoursInSystem:  number | null;
  reportedBy:     string;
}

const POLL_MS = 30 * 60 * 1000;

let moduleCache: { data: StormSystem[]; fetchedAt: number } | null = null;
let inflight: Promise<StormSystem[]> | null = null;

const subscribers = new Set<(d: StormSystem[]) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: StormSystem[]) {
  subscribers.forEach((fn) => fn(d));
}

function load() {
  if (inflight) return inflight;
  inflight = api<StormSystem[]>('/api/storms')
    .then((d) => { moduleCache = { data: d, fetchedAt: Date.now() }; inflight = null; notify(d); return d; })
    .catch(() => { inflight = null; return moduleCache?.data ?? []; });
  return inflight;
}

export function useStorms() {
  const [data, setData] = useState<StormSystem[]>(moduleCache?.data ?? []);

  useEffect(() => {
    subscribers.add(setData);

    const now = Date.now();
    if (!moduleCache || now - moduleCache.fetchedAt >= POLL_MS) {
      load();
    } else {
      setData(moduleCache.data);
    }

    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);

    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, []);

  return data;
}

export function findStorm(storms: StormSystem[], eveSystemId: number | null): StormSystem | undefined {
  if (!eveSystemId) return undefined;
  return storms.find((s) => s.eveSystemId === eveSystemId);
}
