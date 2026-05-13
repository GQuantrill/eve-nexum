import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { flushQueue } from '../store/pendingQueue';

export interface CharacterLocationSystem {
  eveSystemId: number;
  name:        string;
  systemClass: string;
  effect:      string;
  statics:     string[];
  regionName:  string | null;
  npcType:     string | null;
}

export interface CharacterLocation {
  online: boolean;
  system: CharacterLocationSystem | null;
}

interface RawLocationResponse {
  online: boolean;
  system: CharacterLocationSystem | null;
}

const POLL_MS = 10_000;
const EMPTY: CharacterLocation = { online: false, system: null };

let moduleCache: { data: CharacterLocation; fetchedAt: number } | null = null;
let inflight: Promise<CharacterLocation> | null = null;
const subscribers = new Set<(d: CharacterLocation) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: CharacterLocation) {
  subscribers.forEach(fn => fn(d));
}

function load() {
  if (inflight) return inflight;
  inflight = api<RawLocationResponse>('/api/character/location')
    .then(r => {
      const data: CharacterLocation = { online: r.online, system: r.system };
      moduleCache = { data, fetchedAt: Date.now() };
      inflight = null;
      // Successful round-trip — give the offline-write queue a chance to drain.
      flushQueue();
      notify(data);
      return data;
    })
    .catch(() => {
      inflight = null;
      return moduleCache?.data ?? EMPTY;
    });
  return inflight;
}

export function useCharacterLocation(): CharacterLocation {
  const [data, setData] = useState<CharacterLocation>(moduleCache?.data ?? EMPTY);

  useEffect(() => {
    subscribers.add(setData);
    const now = Date.now();
    if (!moduleCache || now - moduleCache.fetchedAt >= POLL_MS) load();
    else setData(moduleCache.data);
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
