import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface IncursionSystem {
  systemId:       number;
  factionId:      number;
  factionName:    string;
  factionLogoUrl: string;
  state:          string;
  influence:      number;
  hasBoss:        boolean;
  isStaging:      boolean;
}

const POLL_MS = 60 * 60 * 1000;

let moduleCache: { data: IncursionSystem[]; fetchedAt: number } | null = null;
let inflight: Promise<IncursionSystem[]> | null = null;

const subscribers = new Set<(d: IncursionSystem[]) => void>();
// Single shared poll timer. Previously every subscribed component created its
// own setInterval — 50 SystemNodes meant 50 timers all hitting /api/incursions
// on the same cadence.
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: IncursionSystem[]) {
  subscribers.forEach((fn) => fn(d));
}

function load() {
  if (inflight) return inflight;
  inflight = api<IncursionSystem[]>('/api/incursions')
    .then((d) => { moduleCache = { data: d, fetchedAt: Date.now() }; inflight = null; notify(d); return d; })
    .catch(() => { inflight = null; return moduleCache?.data ?? []; });
  return inflight;
}

export function useIncursions() {
  const [data, setData] = useState<IncursionSystem[]>(moduleCache?.data ?? []);

  useEffect(() => {
    subscribers.add(setData);

    const now = Date.now();
    if (!moduleCache || now - moduleCache.fetchedAt >= POLL_MS) {
      load();
    } else {
      setData(moduleCache.data);
    }

    // Start the shared timer on the first subscriber.
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

export function findIncursion(incursions: IncursionSystem[], eveSystemId: number | null): IncursionSystem | undefined {
  if (!eveSystemId) return undefined;
  return incursions.find((i) => i.systemId === eveSystemId);
}
