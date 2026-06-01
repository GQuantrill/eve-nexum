import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';

export interface AccountCharLocation {
  charId:        number;
  characterId:   number;
  characterName: string;
  online:        boolean;        // false = position is from last known system
  eveSystemId:   number;
  systemName:    string | null;
  systemClass:   string | null;
}

export interface AccountLocations {
  /** solarSystemId → the account's characters currently shown there. */
  bySystem: Map<number, AccountCharLocation[]>;
  /** users.id → that character's location (for following a tracked character). */
  byChar:   Map<number, AccountCharLocation>;
}

interface RawResponse {
  characters: Array<{
    charId: number; characterId: number; characterName: string;
    online: boolean; eveSystemId: number; systemName: string | null; systemClass: string | null;
  }>;
}

const POLL_MS = 30_000;
const EMPTY: AccountLocations = { bySystem: new Map(), byChar: new Map() };

let moduleCache: { data: AccountLocations; fetchedAt: number } | null = null;
let inflight: Promise<AccountLocations> | null = null;
const subscribers = new Set<(d: AccountLocations) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function indexBySystem(list: AccountCharLocation[]): Map<number, AccountCharLocation[]> {
  const idx = new Map<number, AccountCharLocation[]>();
  for (const c of list) {
    const arr = idx.get(c.eveSystemId);
    if (arr) arr.push(c);
    else idx.set(c.eveSystemId, [c]);
  }
  return idx;
}

function notify(d: AccountLocations) { subscribers.forEach((fn) => fn(d)); }

function load() {
  if (inflight) return inflight;
  inflight = api<RawResponse>('/api/character/account-locations')
    .then((r) => {
      const byChar = new Map<number, AccountCharLocation>();
      for (const c of r.characters) byChar.set(c.charId, c);
      const data: AccountLocations = { bySystem: indexBySystem(r.characters), byChar };
      moduleCache = { data, fetchedAt: Date.now() };
      inflight = null;
      notify(data);
      return data;
    })
    .catch(() => { inflight = null; return moduleCache?.data ?? EMPTY; });
  return inflight;
}

/**
 * The signed-in account's OTHER characters (alts) and where each is — live when
 * online, else their last known system. Shared module cache so every SystemNode
 * consumes a single poll. Empty in share mode (no session).
 */
export function useAccountLocations(): AccountLocations {
  const { isShareMode } = useShareMode();
  const [data, setData] = useState<AccountLocations>(moduleCache?.data ?? EMPTY);

  useEffect(() => {
    if (isShareMode) return;
    subscribers.add(setData);
    const now = Date.now();
    if (!moduleCache || now - moduleCache.fetchedAt >= POLL_MS) load();
    else setData(moduleCache.data);
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
  }, [isShareMode]);

  return isShareMode ? EMPTY : data;
}
