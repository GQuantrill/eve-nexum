import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface InsurgencySystem {
  systemId:         number;
  campaignId:       number;
  factionId:        number;
  factionName:      string;
  factionLogoUrl:   string;
  corruptionPct:    number;
  corruptionState:  number;
  suppressionPct:   number;
  suppressionState: number;
}

const POLL_MS = 60 * 60 * 1000;

let moduleCache: { data: InsurgencySystem[]; fetchedAt: number } | null = null;
let inflight: Promise<InsurgencySystem[]> | null = null;

const subscribers = new Set<(d: InsurgencySystem[]) => void>();
// Single shared poll timer (see useIncursions for the same pattern).
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: InsurgencySystem[]) {
  subscribers.forEach((fn) => fn(d));
}

function load() {
  if (inflight) return inflight;
  inflight = api<InsurgencySystem[]>('/api/insurgency')
    .then((d) => { moduleCache = { data: d, fetchedAt: Date.now() }; inflight = null; notify(d); return d; })
    .catch(() => { inflight = null; return moduleCache?.data ?? []; });
  return inflight;
}

export function useInsurgency() {
  const [data, setData] = useState<InsurgencySystem[]>(moduleCache?.data ?? []);

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

export function findInsurgency(insurgencies: InsurgencySystem[], eveSystemId: number | null): InsurgencySystem | undefined {
  if (!eveSystemId) return undefined;
  return insurgencies.find((i) => i.systemId === eveSystemId);
}
