import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { api } from '../api/client';

// Reports the viewer's own location to the active map so the server can fan it
// out as presence. Only reports when we actually have a location (online + in a
// known system) — inheriting the location opt-in. Heartbeats to keep the
// server-side TTL alive; the SSE disconnect handles "left". See
// presence_feature.md.
const HEARTBEAT_MS = 25_000;

export function useMapPresence(): void {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const location = useCharacterLocation();
  const eveSystemId = location.online && location.system ? location.system.eveSystemId : null;

  useEffect(() => {
    if (!activeMapId || eveSystemId == null) return;
    const report = () => {
      api(`/api/maps/${activeMapId}/presence`, {
        method: 'POST',
        body: JSON.stringify({ eveSystemId }),
      }).catch(() => { /* presence is best-effort */ });
    };
    report();
    const hb = setInterval(report, HEARTBEAT_MS);
    return () => clearInterval(hb);
  }, [activeMapId, eveSystemId]);
}
