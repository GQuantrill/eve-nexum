import { useEffect, useMemo } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useAccountLocations } from './useAccountLocations';
import { api } from '../api/client';
import { useUserSetting } from './useUserSetting';

// Reports the viewer's own location to the active map so the server can fan it
// out as presence. Only reports when we actually have a location (online + in a
// known system) — inheriting the location opt-in. Heartbeats to keep the
// server-side TTL alive; the SSE disconnect handles "left". See
// presence_feature.md.
const HEARTBEAT_MS = 25_000;

export function useMapPresence(): void {
  const activeMapId = useMapStore((s) => s.activeMapId);
  // Opt-out of being SEEN. Deliberately not the same switch as "track jumps",
  // which only decides whether the map grows as you fly — turning that off to
  // keep a map tidy shouldn't silently remove you from your corp's view.
  const [hidden] = useUserSetting<boolean>('nexum.presence.hidden', false);
  const location = useCharacterLocation();
  const accountLocations = useAccountLocations();
  const eveSystemId = location.online && location.system ? location.system.eveSystemId : null;

  // Every system an account character is *physically in right now* — the active
  // viewer plus any online alt. This is what keeps a system from going stale:
  // it must be independent of which character is the active viewer, so a tracked
  // alt (or an alt flying a different route) revives its own system too. Only
  // online characters count — last-known positions must not keep a system fresh
  // forever. The active character's eveSystemId is the presence "dot"; these are
  // purely the staleness signal.
  const presentSystemIds = useMemo(() => {
    const ids = new Set<number>();
    if (eveSystemId != null) ids.add(eveSystemId);
    for (const c of accountLocations.byChar.values()) {
      if (c.online) ids.add(c.eveSystemId);
    }
    return [...ids];
  }, [eveSystemId, accountLocations]);
  // Stable primitive for the effect dep so it doesn't re-subscribe on every poll
  // when the set of occupied systems hasn't actually changed.
  const presentKey = presentSystemIds.join(',');

  useEffect(() => {
    if (!activeMapId) return;
    // Turning the toggle on mid-session has to take a dot that's already on
    // other people's screens away NOW — waiting out the 60 s server TTL would
    // leave you visible for up to a minute after asking not to be.
    if (hidden) {
      api(`/api/maps/${activeMapId}/presence`, { method: 'DELETE' })
        .catch(() => { /* best-effort; the TTL sweeps it regardless */ });
      return;
    }
    if (eveSystemId == null && presentSystemIds.length === 0) return;
    const report = () => {
      api(`/api/maps/${activeMapId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ eveSystemId, presentSystemIds }),
      }).catch(() => { /* presence is best-effort */ });
    };
    report();
    const hb = setInterval(report, HEARTBEAT_MS);
    return () => clearInterval(hb);
    // presentSystemIds tracked via presentKey to avoid array-identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMapId, eveSystemId, presentKey, hidden]);
}
