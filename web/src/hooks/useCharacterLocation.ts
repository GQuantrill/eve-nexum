import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { flushQueue } from '../store/pendingQueue';
import { useShareMode } from '../context/ShareModeContext';
import { useMapStore } from '../store/mapStore';

// The character THIS TAB acts as: the per-tab pinned character (a routeOrigin
// override) when one is set, otherwise null to follow the session-active
// character via the shared active-location endpoint.
function actingCharId(): number | null {
  try { return useMapStore.getState().routeOrigin?.charId ?? null; } catch { return null; }
}

export interface CharacterLocationSystem {
  eveSystemId: number;
  name:        string;
  systemClass: string;
  effect:      string;
  statics:     string[];
  regionName:  string | null;
  npcType:     string | null;
}

export interface CharacterShip {
  typeId:   number;
  typeName: string;
  shipName: string;
  /** Ship mass in kg from EVE SDE. null if the SDE row is missing. */
  mass:     number | null;
}

export interface CharacterLocation {
  online: boolean;
  system: CharacterLocationSystem | null;
  ship:   CharacterShip | null;
}

interface RawLocationResponse {
  online: boolean;
  system: CharacterLocationSystem | null;
  ship:   CharacterShip | null;
}

const POLL_MS = 10_000;
const EMPTY: CharacterLocation = { online: false, system: null, ship: null };

let moduleCache: { charId: number | null; data: CharacterLocation; fetchedAt: number } | null = null;
let inflight: Promise<CharacterLocation> | null = null;
// The acting char id the current in-flight request is for — so an in-flight
// fetch is only reused when it's for the SAME character, not a stale one.
let inflightCharId: number | null = null;
const subscribers = new Set<(d: CharacterLocation) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: CharacterLocation) {
  subscribers.forEach(fn => fn(d));
}

function load() {
  const charId = actingCharId();
  // Reuse an in-flight request only when it's for the character we still want.
  if (inflight && inflightCharId === charId) return inflight;
  const url = charId == null ? '/api/character/location' : '/api/character/' + charId + '/location';
  inflightCharId = charId;
  inflight = api<RawLocationResponse>(url)
    .then(r => {
      const data: CharacterLocation = { online: r.online, system: r.system, ship: r.ship ?? null };
      inflight = null;
      // The acting character may have changed while this was in flight — if so,
      // discard the result rather than caching/broadcasting a stale char.
      if (actingCharId() !== charId) return data;
      moduleCache = { charId, data, fetchedAt: Date.now() };
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
  const { isShareMode } = useShareMode();
  const actingId = useMapStore((s) => s.routeOrigin?.charId ?? null);
  const [data, setData] = useState<CharacterLocation>(moduleCache?.data ?? EMPTY);

  useEffect(() => {
    // No session in share mode — nothing to poll and nobody to be located.
    if (isShareMode) return;

    subscribers.add(setData);
    const now = Date.now();
    // Serve the cache synchronously only when it's for the acting character and
    // still fresh; otherwise fetch. Read the live acting id (not the render-time
    // `actingId`) so this effect needn't re-run on every character switch — the
    // dedicated effect below handles switches.
    if (moduleCache && moduleCache.charId === actingCharId() && now - moduleCache.fetchedAt < POLL_MS) setData(moduleCache.data);
    else load();
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [isShareMode]);

  // Switching the pinned (acting) character must re-fetch right away rather than
  // waiting for the next poll tick. Invalidate a stale-char cache first so no
  // consumer briefly reads the previous character's location.
  useEffect(() => {
    if (isShareMode) return;
    if (moduleCache && moduleCache.charId !== actingId) moduleCache = null;
    load();
  }, [actingId, isShareMode]);

  return isShareMode ? EMPTY : data;
}
