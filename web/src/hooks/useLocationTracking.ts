import { useEffect, useRef } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useCanEdit } from './useCanEdit';
import type { SystemClass, WormholeEffect } from '../types';

interface Box { position: { x: number; y: number } }

// AABB overlap test between two top-left-anchored w×h boxes, padded by `gap`.
function boxesOverlap(ax: number, ay: number, bx: number, by: number, w: number, h: number, gap: number): boolean {
  return ax < bx + w + gap && ax + w + gap > bx && ay < by + h + gap && ay + h + gap > by;
}

// Pick a position for a newly auto-added system: the intended spot if it's
// clear, otherwise stack straight down beneath it into the first free slot
// (so repeated jumps out of one system form a tidy column). Only if that whole
// column is blocked do we spread outward. Stops a second jump out of the same
// system from landing on top of the first one.
function findFreePosition(
  start: { x: number; y: number },
  systems: Box[],
  w: number,
  h: number,
  gap: number,
): { x: number; y: number } {
  const collides = (x: number, y: number) =>
    systems.some((s) => boxesOverlap(x, y, s.position.x, s.position.y, w, h, gap));

  const stepX = w + gap;
  const stepY = h + gap;

  // Prefer the intended spot, then directly below it, then further down.
  for (let i = 0; i < 20; i++) {
    const y = start.y + i * stepY;
    if (!collides(start.x, y)) return { x: start.x, y };
  }

  // Column full — spread outward in rings (Chebyshev) as a fallback.
  for (let ring = 1; ring <= 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // perimeter only
        const x = start.x + dx * stepX;
        const y = start.y + dy * stepY;
        if (!collides(x, y)) return { x, y };
      }
    }
  }
  return start; // map is unusually dense — fall back rather than loop forever
}

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
    const { map, addSystem, addConnection, optimizeConnections, selectSystem, setCurrentSystem, uniformWidth, uniformHeight } = useMapStore.getState();

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
      const w = uniformWidth || 220;
      const h = uniformHeight || 120;
      const gap = 30;
      const stepX = w + 60;
      // Intended spot: just to the right of the system we jumped from (or the
      // map centroid for the very first auto-add).
      let intended: { x: number; y: number };
      if (prevMapSystemId) {
        const prevSys = map.systems.find((s) => s.id === prevMapSystemId)!;
        intended = { x: prevSys.position.x + stepX, y: prevSys.position.y };
      } else {
        const cx = map.systems.length
          ? map.systems.reduce((sum, s) => sum + s.position.x, 0) / map.systems.length
          : 0;
        const cy = map.systems.length
          ? map.systems.reduce((sum, s) => sum + s.position.y, 0) / map.systems.length
          : 0;
        intended = { x: cx + stepX, y: cy };
      }
      // ...but never on top of an existing node — find the nearest free slot.
      const position = findFreePosition(intended, map.systems, w, h, gap);

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
      if (!alreadyConnected) {
        addConnection(prevMapSystemId, mapSystemId, 'right', 'left');
        // The handles above are a default; re-pick the optimal source/target
        // sides for every connection now that the new system is in place, so
        // an auto-added jump doesn't end up with a connection drawn through
        // the system on the wrong side.
        optimizeConnections();
      }
    }

    lastMapSystemId.current = mapSystemId;
    setCurrentSystem(mapSystemId);
    selectSystem(mapSystemId);
  }, [enabled, location, canEdit]);
}
