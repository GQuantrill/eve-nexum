import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface ScoutConnection {
  id:             string;
  whType:         string;
  maxShipSize:    string;
  expiresAt:      string;
  remainingHours: number;
  outSystemId:    number;
  outSystemName:  string;
  outSignature:   string;
  inSystemId:     number;
  inSystemName:   string;
  inSystemClass:  string | null;
  inRegionId:     number;
  inRegionName:   string;
  inSignature:    string;
  whExitsOutward: boolean;
}

const POLL_MS = 5 * 60 * 1000;

let moduleCache: { data: ScoutConnection[]; fetchedAt: number } | null = null;
let inflight: Promise<ScoutConnection[]> | null = null;
const subscribers = new Set<(d: ScoutConnection[]) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: ScoutConnection[]) {
  subscribers.forEach(fn => fn(d));
}

// True when two polls hold the same scout connections, so we keep the previous
// reference and skip the all-node re-render. remainingHours is included so the
// ScoutConnectionsPane countdown stays live — meaning this fires mainly in the
// common no-connections case (empty === empty), which is exactly the fan-out
// worth eliminating for the majority of maps.
function sameScout(a: ScoutConnection[], b: ScoutConnection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id             !== y.id
        || x.remainingHours !== y.remainingHours
        || x.expiresAt      !== y.expiresAt
        || x.inSystemId     !== y.inSystemId
        || x.outSystemName  !== y.outSystemName) return false;
  }
  return true;
}

function load() {
  if (inflight) return inflight;
  inflight = api<ScoutConnection[]>('/api/scout')
    .then(d => {
      inflight = null;
      const prev = moduleCache?.data;
      if (prev && sameScout(prev, d)) {
        moduleCache = { data: prev, fetchedAt: Date.now() };
        return prev;
      }
      moduleCache = { data: d, fetchedAt: Date.now() };
      notify(d);
      return d;
    })
    .catch(() => { inflight = null; return moduleCache?.data ?? []; });
  return inflight;
}

export function findScoutConnections(
  connections: ScoutConnection[],
  eveSystemId: number | null,
): ScoutConnection[] {
  if (!eveSystemId) return [];
  return connections.filter(c => c.inSystemId === eveSystemId);
}

export function useScoutConnections() {
  const [data, setData] = useState<ScoutConnection[]>(moduleCache?.data ?? []);

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
