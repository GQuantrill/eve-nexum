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

function load() {
  if (inflight) return inflight;
  inflight = api<ScoutConnection[]>('/api/scout')
    .then(d => { moduleCache = { data: d, fetchedAt: Date.now() }; inflight = null; notify(d); return d; })
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
