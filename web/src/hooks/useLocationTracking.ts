import { useEffect, useRef } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useCanEdit } from './useCanEdit';
import type { SystemClass, WormholeEffect } from '../types';

/**
 * Map-side reaction to character location changes. The actual polling lives
 * in `useCharacterLocation` (10s, module-level, shared with the sidebar);
 * this hook just runs map-mutation side-effects whenever the location data
 * advances and a map is active.
 */
export function useLocationTracking(enabled: boolean) {
  const location = useCharacterLocation();
  const canEdit  = useCanEdit();
  const lastEveSystemId = useRef<number | null>(null);
  const lastMapSystemId = useRef<string | null>(null);
  const lastActiveMapId = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const { map, addSystem, addConnection, selectSystem, setCurrentSystem, uniformWidth } = useMapStore.getState();

    // No active map loaded yet (mid switchMap / first paint) — wait for the
    // next location update rather than racing addSystem against an empty store.
    if (!map.id) return;

    // Reset refs when the active map changes
    if (map.id !== lastActiveMapId.current) {
      lastActiveMapId.current = map.id;
      lastEveSystemId.current = null;
      lastMapSystemId.current = null;
    }

    const system = location.system;
    if (!location.online || !system) {
      lastEveSystemId.current = null;
      lastMapSystemId.current = null;
      setCurrentSystem(null);
      return;
    }

    if (system.eveSystemId === lastEveSystemId.current) return;

    let prevMapSystemId = lastMapSystemId.current;
    // The previous system may have been removed from the map by another
    // client while we were elsewhere — drop the stale ref so we fall through
    // to the center-of-mass placement instead of `{x:200,y:0}`.
    if (prevMapSystemId && !map.systems.some((s) => s.id === prevMapSystemId)) {
      prevMapSystemId = null;
      lastMapSystemId.current = null;
    }
    lastEveSystemId.current = system.eveSystemId;

    let mapSystemId: string;
    const existing = map.systems.find((s) => s.eveSystemId === system.eveSystemId);
    const trackJumps = useMapStore.getState().trackJumps;
    if (existing) {
      mapSystemId = existing.id;
    } else {
      // A locked map never grows from passive location tracking — that
      // includes admins, who can still place systems manually via the
      // canvas but shouldn't sprout them just by hopping through EVE.
      // Readonly / no-topology-permission users are also blocked here.
      // Track-jumps off explicitly opts the user out of the auto-add.
      if (!trackJumps || map.locked || !canEdit) {
        lastMapSystemId.current = null;
        setCurrentSystem(null);
        return;
      }
      // Offset by the widest node seen + a gap so an auto-added system never
      // overlaps the one it's placed next to (positions are top-left corners;
      // a flat +200 touched because nodes are ~200 wide). Falls back to a
      // generous constant before any node has been measured.
      const stepX = (uniformWidth || 220) + 60;
      let position: { x: number; y: number };
      if (prevMapSystemId) {
        const prevSys = map.systems.find((s) => s.id === prevMapSystemId)!;
        position = { x: prevSys.position.x + stepX, y: prevSys.position.y };
      } else {
        const cx = map.systems.length
          ? map.systems.reduce((sum, s) => sum + s.position.x, 0) / map.systems.length
          : 0;
        const cy = map.systems.length
          ? map.systems.reduce((sum, s) => sum + s.position.y, 0) / map.systems.length
          : 0;
        position = { x: cx + stepX, y: cy };
      }

      mapSystemId = addSystem(
        system.name,
        system.systemClass as SystemClass,
        position,
        {
          eveSystemId: system.eveSystemId,
          effect:      system.effect as WormholeEffect,
          statics:     system.statics,
          regionName:  system.regionName,
          npcType:     system.npcType,
        },
      );
    }

    if (trackJumps && canEdit && !map.locked && prevMapSystemId && prevMapSystemId !== mapSystemId) {
      const freshConnections = useMapStore.getState().map.connections;
      const alreadyConnected = freshConnections.some(
        (c) =>
          (c.sourceId === prevMapSystemId && c.targetId === mapSystemId) ||
          (c.sourceId === mapSystemId && c.targetId === prevMapSystemId),
      );
      if (!alreadyConnected) addConnection(prevMapSystemId, mapSystemId, 'right', 'left');
    }

    lastMapSystemId.current = mapSystemId;
    setCurrentSystem(mapSystemId);
    selectSystem(mapSystemId);
  }, [enabled, location, canEdit]);
}
