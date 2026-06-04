import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';

export type ContactKind = 'character' | 'corporation' | 'alliance' | 'faction';

export interface StandingsLookup {
  character: number | null;
  corp:      number | null;
  alliance:  number | null;
  effective: number;   // most negative non-null across the three, 0 if none
  isHostile:  boolean; // effective < -5 — red "terrible" band (-10 territory)
  isFriendly: boolean; // effective >  5 — dark-blue "excellent" band (+10 territory)
  isNeutral:  boolean; // not hostile and not friendly
}

interface StandingsResponse {
  characterId: number;
  corpId:      number | null;
  allianceId:  number | null;
  character:   Record<string, number>;
  corp:        Record<string, number>;
  alliance:    Record<string, number>;
}

// Module-level cache so the standings payload is fetched once per page
// load and shared by every hook consumer. The Standings card, the
// Structures pane, the Killboard pane, and the system-node halo all read
// from the same in-memory store — no need to refetch when navigating
// between systems on the map.
let cache: StandingsResponse | null = null;
let loading = false;
let refreshing = false;
const listeners = new Set<() => void>();

function notify() { for (const l of listeners) l(); }

async function load() {
  if (cache || loading) return;
  loading = true;
  try {
    cache = await api<StandingsResponse>('/api/standings/me');
  } catch {
    // 401 (unauthed) is the typical failure; leave cache empty and try
    // again next mount.
    cache = null;
  } finally {
    loading = false;
    notify();
  }
}

// Force-refresh: POSTs to /api/standings/refresh to re-pull from ESI
// (bypassing the 6h server TTL), then reloads the cache. Returns the
// refresh result so callers can show "X new contacts" or similar.
async function refreshFromEsi(): Promise<{
  ok: boolean;
  counts?:    { character: number; corp: number; alliance: number };
  succeeded?: { character: boolean; corp: boolean; alliance: boolean };
} | null> {
  if (refreshing) return null;
  refreshing = true;
  notify();
  try {
    const result = await api<{
      ok: boolean;
      counts:    { character: number; corp: number; alliance: number };
      succeeded: { character: boolean; corp: boolean; alliance: boolean };
    }>('/api/standings/refresh', { method: 'POST' });
    // Force a re-pull of the GET endpoint so the cache reflects the
    // freshly-written DB rows.
    cache = null;
    await load();
    return result;
  } catch (err) {
    console.error('standings refresh failed:', err);
    return null;
  } finally {
    refreshing = false;
    notify();
  }
}

const EMPTY: StandingsLookup = {
  character: null, corp: null, alliance: null,
  effective: 0, isHostile: false, isFriendly: false, isNeutral: true,
};

export function useStandings() {
  // Increments on every standings change (notify) — used as the memo key so
  // the returned object updates exactly when the data changes and is otherwise
  // referentially stable, letting consumers (every map node) memoize cleanly.
  const [tick, setTick] = useState(0);
  const { isShareMode } = useShareMode();

  useEffect(() => {
    // Share viewers don't have a session and standings are intentionally
    // private — the load() call would 401 and the data wouldn't be
    // meaningful even if it succeeded.
    if (isShareMode) return;
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    if (!cache) load();
    return () => { listeners.delete(listener); };
  }, [isShareMode]);

  // Stable identity; reads the module cache at call time so it stays correct
  // as the cache updates without forcing a new closure each render.
  const getStanding = useCallback((kind: ContactKind, id: number): StandingsLookup => {
    if (!cache) return EMPTY;
    const key = `${kind}:${id}`;
    const character = cache.character[key] ?? null;
    const corp      = cache.corp[key]      ?? null;
    const alliance  = cache.alliance[key]  ?? null;

    const values = [character, corp, alliance].filter((v): v is number => v !== null);
    const effective = values.length ? Math.min(...values) : 0;
    return {
      character, corp, alliance, effective,
      isHostile:  effective < -5,
      isFriendly: effective >  5,
      isNeutral:  effective >= -5 && effective <= 5,
    };
  }, []);

  return useMemo(() => ({
    loaded: !!cache,
    refreshing,
    getStanding,
    self: cache ? { characterId: cache.characterId, corpId: cache.corpId, allianceId: cache.allianceId } : null,
    refresh: refreshFromEsi,
  // `tick` (bumped by notify) is the data-version key; getStanding is stable.
  }), [tick, getStanding]);
}

// Convenience for code that only needs the loader (no per-target lookups).
export function preloadStandings() { void load(); }
