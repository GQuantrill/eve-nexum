import { useEffect, useRef } from 'react';
import { useMapStore, type RemoteEvent } from '../store/mapStore';
import { usePresenceStore, type PresenceViewer } from '../store/presenceStore';
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
    usePresenceStore.getState().reset(); // clear last map's roster; snapshot repopulates

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
        const data = JSON.parse(e.data) as { type: string; actor?: string | null } & Record<string, unknown>;
        const presence = usePresenceStore.getState();
        // Presence events are ephemeral UI state — route to the presence store,
        // not mapStore. (snapshot/leave carry no actor; only update is echoed.)
        switch (data.type) {
          case 'presence.snapshot':
            presence.snapshot((data.viewers as PresenceViewer[] | undefined) ?? []);
            return;
          case 'presence.update':
            if (data.actor !== CLIENT_ID) presence.upsert(data as unknown as PresenceViewer);
            return;
          case 'presence.leave':
            presence.remove(data.characterId as number);
            return;
        }

        if (data.actor === CLIENT_ID) return; // our own echo — already applied
        useMapStore.getState().applyRemote(data as unknown as RemoteEvent);
      } catch { /* ignore malformed frame */ }
    };

    return () => es.close();
  }, [activeMapId]);
}
