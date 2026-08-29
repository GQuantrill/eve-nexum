import { useEffect, useSyncExternalStore } from 'react';
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

// ESI caches character location for ~5 s. We poll every 10 s: a system change
// is still caught within ~10 s, while keeping the per-session request rate low
// — a faster 5 s cadence pushed enough traffic to risk rate-limit stalls (which
// surfaced as the location going out of sync). A visibility/focus catch-up
// (below) covers the gap the moment the tab is looked at.
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
const subscribers = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function notify() { subscribers.forEach((fn) => fn()); }

// Browsers throttle (or pause) timers in hidden/background tabs — and an EVE
// mapper usually sits behind the game client — so the interval can stall and the
// location go stale. Refetch immediately whenever the tab becomes visible or the
// window regains focus, so it's fresh the moment it's looked at. load() dedupes
// an in-flight request, so a double focus/visibility fire is harmless.
function catchUp(): void { if (document.visibilityState === 'visible') load(); }

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (!pollTimer) {
    pollTimer = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
    }
  };
}
// Stable references for useSyncExternalStore.
const noopSubscribe = (): (() => void) => () => {};
const getSnapshot = () => moduleCache?.data ?? EMPTY;
const getEmpty = () => EMPTY;

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
      notify();
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
  const enabled = !isShareMode;

  // Point the shared poll at this tab's acting character and (re)fetch whenever
  // it changes (pin toggled, or the session identity changed). Side-effect only
  // — the value comes from the store below. When the cache already holds a fresh
  // result for this character we skip the fetch; when it's a different character
  // the previous location lingers until the new one arrives (the store keeps
  // returning it), exactly as before.
  useEffect(() => {
    if (!enabled) return;
    currentActingId = effective;
    const fresh = !!moduleCache && moduleCache.charId === effective
      && Date.now() - moduleCache.fetchedAt < POLL_MS;
    if (!fresh) load();
  }, [effective, enabled]);

  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? getSnapshot : getEmpty,
    getEmpty,
  );
}
