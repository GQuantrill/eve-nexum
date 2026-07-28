import { api } from '../api/client';
import { useMapStore, awaitConnectionType } from '../store/mapStore';

// Fire-and-forget recorder for the connection jump log. Called when the acting
// character physically jumps a mapped connection. Best-effort intel: it POSTs the
// crossing and the server broadcasts it back over SSE (which fills the store) — a
// failure must NEVER disrupt location tracking, and this never touches mass_used.

interface RecordArgs {
  mapId:           string;
  connId:          string;
  fromMapSystemId: string;   // map-system id the pilot departed
  toMapSystemId:   string;   // map-system id the pilot arrived at
  shipTypeId:      number | null;
  actingCharId:    number | null;   // users.id the tab is following (verified server-side)
}

export function recordConnectionJump(args: RecordArgs): void {
  const { mapId, connId, fromMapSystemId, toMapSystemId, shipTypeId, actingCharId } = args;
  if (!mapId || !connId) return;
  // No ship (offline / capsule with no type) → nothing worth logging.
  if (shipTypeId == null) return;

  void (async () => {
    try {
      // Only WORMHOLE connections carry mass, so a gate / jump-bridge crossing
      // isn't interesting here. Use the server gate classification, awaiting a
      // freshly-created connection's POST — the same guard whJumpConfirm uses.
      const pending = awaitConnectionType(connId);
      const ct = pending
        ? await pending
        : useMapStore.getState().map.connections.find((c) => c.id === connId)?.connectionType ?? 'standard';
      if (ct !== 'standard') return;

      const { connections, systems } = useMapStore.getState().map;
      // Direction is relative to the connection's stored endpoints (a cheap
      // summary field); the from/to system ids below make each row self-describing.
      const conn = connections.find((c) => c.id === connId);
      const direction = conn && conn.sourceId === fromMapSystemId ? 'forward' : 'reverse';
      const fromEveSystemId = systems.find((s) => s.id === fromMapSystemId)?.eveSystemId ?? null;
      const toEveSystemId   = systems.find((s) => s.id === toMapSystemId)?.eveSystemId ?? null;

      await api(`/api/maps/${mapId}/connections/${connId}/jumps`, {
        method: 'POST',
        body: JSON.stringify({ shipTypeId, direction, actingCharId, fromEveSystemId, toEveSystemId }),
      });
    } catch {
      /* best-effort — swallow (share mode, offline, permission, etc.) */
    }
  })();
}
