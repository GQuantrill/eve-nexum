import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface SystemKills {
  systemId:  number;
  shipKills: number;
  podKills:  number;
  npcKills:  number;
  jumps:     number;
}

const POLL_MS = 5 * 60 * 1000;
const EMPTY = new Map<number, SystemKills>();

let cache: Map<number, SystemKills> = EMPTY;
let cacheAt = 0;
let inflight: Promise<Map<number, SystemKills>> | null = null;
const subscribers = new Set<(d: Map<number, SystemKills>) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: Map<number, SystemKills>) {
  subscribers.forEach(fn => fn(d));
}

// True when two fetches hold identical kill counts, so we keep the previous Map
// reference and skip the all-node re-render. The 5-min poll is a reconciliation
// backstop (it also catches kills aging out of the live window, which fire no
// event); most polls are no-ops, and live kills refresh via refreshCurrentKills.
function sameKills(a: Map<number, SystemKills>, b: Map<number, SystemKills>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb
        || vb.shipKills !== va.shipKills
        || vb.podKills  !== va.podKills
        || vb.npcKills  !== va.npcKills
        || vb.jumps     !== va.jumps) return false;
  }
  return true;
}

function load() {
  if (inflight) return inflight;
  inflight = api<SystemKills[]>('/api/activity/current-kills')
    .then(rows => {
      inflight = null;
      const next = new Map(rows.map(r => [r.systemId, r]));
      cacheAt = Date.now();
      if (sameKills(cache, next)) return cache;
      cache = next;
      notify(cache);
      return cache;
    })
    .catch(() => { inflight = null; return cache; });
  return inflight;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Trigger a refetch from the live kill feed (called on each `kill.recent` SSE),
// so the heatmap updates within ~a second of a kill instead of waiting for the
// 5-min poll. Debounced: a burst of kills coalesces into ONE refetch, and the
// server holds the authoritative windowed count so this can't drift (unlike an
// optimistic bump). No-op when nothing is displaying the heatmap.
export function refreshCurrentKills(): void {
  if (refreshTimer || subscribers.size === 0) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load();
  }, 1500);
}

export function useCurrentHourKills(): Map<number, SystemKills> {
  const [data, setData] = useState<Map<number, SystemKills>>(cache);

  useEffect(() => {
    subscribers.add(setData);
    if (cache === EMPTY || Date.now() - cacheAt >= POLL_MS) load();
    else setData(cache);
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
