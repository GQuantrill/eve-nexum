import { useEffect, useRef } from 'react';
import { useMapStore, type RemoteEvent } from '../store/mapStore';
import { apiUrl } from '../api/client';
import { CLIENT_ID } from '../api/clientId';

// Subscribes to the active map's live-edit SSE stream and applies incoming
// edits from other clients to the store. One stream at a time — it follows
// activeMapId. EventSource reconnects automatically; on a *re*connect we
// re-fetch the map to catch anything missed while disconnected. See
// realtime_sync_feature.md.
export function useMapEventStream(): void {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const openedOnce = useRef(false);

  useEffect(() => {
    if (!activeMapId) return;
    openedOnce.current = false;

    const es = new EventSource(apiUrl(`/api/maps/${activeMapId}/events`), { withCredentials: true });

    es.addEventListener('open', () => {
      // First 'open' is the initial connect — the map was just loaded, so no
      // resync needed. Any later 'open' is a reconnect → resync.
      if (openedOnce.current) {
        const { activeMapId: id, switchMap } = useMapStore.getState();
        if (id) void switchMap(id);
      }
      openedOnce.current = true;
    });

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as RemoteEvent & { actor?: string | null };
        if (data.actor === CLIENT_ID) return; // our own echo — already applied
        useMapStore.getState().applyRemote(data);
      } catch { /* ignore malformed frame */ }
    };

    return () => es.close();
  }, [activeMapId]);
}
