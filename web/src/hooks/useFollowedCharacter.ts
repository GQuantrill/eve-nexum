import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';
import { useAuth } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation, type CharacterLocation } from './useCharacterLocation';

// Which of the account's characters THIS TAB follows for auto-add jump tracking.
// It's the character pinned via the character switcher's focus button — stored
// in the per-tab `routeOrigin` store field (a client-only override, so each tab
// is independent) — or null to follow the session-active character (default).
// Pinning is how a multiboxer makes two tabs track two characters onto two maps
// at once, with no separate character selector.
const POLL_MS = 10_000;
const EMPTY: CharacterLocation = { online: false, system: null, ship: null };

/** The per-tab followed user id (the pinned character), or null for the active character. */
export function useFollowedCharacterId(): number | null {
  return useMapStore((s) => s.routeOrigin?.charId ?? null);
}

interface RawLocationResponse {
  online: boolean;
  system: CharacterLocation['system'];
  ship:   CharacterLocation['ship'];
}

/**
 * Poll another account character's location. When `userId` is null (we're
 * following the active character) this returns EMPTY and does no polling — the
 * caller reuses the shared active poll instead. Consumed once (by the tracker),
 * so a simple per-hook poller is fine; no shared module cache needed.
 */
export function useOtherCharacterLocation(userId: number | null): CharacterLocation {
  const { isShareMode } = useShareMode();
  const [data, setData] = useState<CharacterLocation>(EMPTY);

  useEffect(() => {
    // No session in share mode, and nothing to poll when following the active
    // character (userId null) — reset to EMPTY and bail.
    if (isShareMode || userId == null) {
      setData(EMPTY);
      return;
    }

    let cancelled = false;
    setData(EMPTY); // re-initialise when the followed character changes

    async function load() {
      try {
        const r = await api<RawLocationResponse>(`/api/character/${userId}/location`);
        if (!cancelled) setData({ online: r.online, system: r.system, ship: r.ship ?? null });
      } catch {
        // Keep the last value on a transient failure.
      }
    }

    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isShareMode, userId]);

  return isShareMode ? EMPTY : data;
}

/**
 * The location that auto-add jump tracking should follow on THIS tab: the
 * per-tab pinned character when one is set, otherwise the session-active
 * character. Both sub-hooks are always called (hooks rules); only a genuinely
 * different character adds a second poll — following the active character reuses
 * the existing shared active poll.
 */
export function useFollowedCharacterLocation(): CharacterLocation {
  const followedId = useFollowedCharacterId();
  const { user } = useAuth();
  const activeId = user?.id ?? null;
  const followingOther = followedId != null && followedId !== activeId;
  const active = useCharacterLocation();
  const other  = useOtherCharacterLocation(followingOther ? followedId : null);
  return followingOther ? other : active;
}
