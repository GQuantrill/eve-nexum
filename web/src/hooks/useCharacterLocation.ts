import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { flushQueue } from '../store/pendingQueue';
import { useShareMode } from '../context/ShareModeContext';
import { useMapStore } from '../store/mapStore';
import { useAuth } from '../context/AuthContext';

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

// The users.id of the character THIS TAB currently acts as: the per-tab pinned
// character (routeOrigin) when set, else the tab's own session-active character.
// Kept in a module var (written by the hook, which has the auth context) so the
// shared poll can read it. Location is ALWAYS resolved by explicit id via
// /api/character/:id/location — never the session-global /api/character/location
// — so a tab's location always matches the character it displays, even when
// another tab has switched the session identity out from under it.
let currentActingId: number | null = null;

let moduleCache: { charId: number | null; data: CharacterLocation; fetchedAt: number } | null = null;
let inflight: Promise<CharacterLocation> | null = null;
// The acting char id the in-flight request is for — so we only reuse it when
// it's still the character we want, not a stale one.
let inflightCharId: number | null = null;
const subscribers = new Set<(d: CharacterLocation) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify(d: CharacterLocation) {
  subscribers.forEach(fn => fn(d));
}

function load(): Promise<CharacterLocation> {
  const charId = currentActingId;
  if (charId == null) return Promise.resolve(moduleCache?.data ?? EMPTY);
  if (inflight && inflightCharId === charId) return inflight;
  inflightCharId = charId;
  inflight = api<RawLocationResponse>(`/api/character/${charId}/location`)
    .then(r => {
      const data: CharacterLocation = { online: r.online, system: r.system, ship: r.ship ?? null };
      inflight = null;
      // The acting character may have changed while this was in flight — if so,
      // discard rather than caching/broadcasting a stale character's location.
      if (currentActingId !== charId) return data;
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

/**
 * The live location of the character THIS TAB acts as (pinned character, else
 * the session-active one). A single shared poll; re-points and re-fetches
 * whenever the acting character changes.
 */
export function useCharacterLocation(): CharacterLocation {
  const { isShareMode } = useShareMode();
  const { user } = useAuth();
  const routeCharId = useMapStore((s) => s.routeOrigin?.charId ?? null);
  // Explicit acting id: a pin, else this tab's own character. Null only before
  // auth has loaded.
  const effective = routeCharId ?? user?.id ?? null;
  const [data, setData] = useState<CharacterLocation>(moduleCache?.data ?? EMPTY);

  useEffect(() => {
    if (isShareMode) return;
    subscribers.add(setData);
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [isShareMode]);

  // Point the shared poll at the effective acting character and fetch right away
  // whenever it changes (pin toggled, or the session identity changed).
  useEffect(() => {
    if (isShareMode) return;
    currentActingId = effective;
    if (moduleCache && moduleCache.charId === effective && Date.now() - moduleCache.fetchedAt < POLL_MS) {
      setData(moduleCache.data);
    } else {
      if (moduleCache && moduleCache.charId !== effective) moduleCache = null;
      load();
    }
  }, [effective, isShareMode]);

  return isShareMode ? EMPTY : data;
}
