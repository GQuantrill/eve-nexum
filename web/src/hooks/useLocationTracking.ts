import { useEffect, useRef } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useCanEdit } from './useCanEdit';
import { readUserSetting } from './useUserSetting';
import { pickHandles } from '../components/map/edgeUtils';
import type { SystemClass, WormholeEffect } from '../types';

interface Box { position: { x: number; y: number } }

// AABB overlap test between two top-left-anchored w×h boxes, padded by `gap`.
function boxesOverlap(ax: number, ay: number, bx: number, by: number, w: number, h: number, gap: number): boolean {
  return ax < bx + w + gap && ax + w + gap > bx && ay < by + h + gap && ay + h + gap > by;
}

// Snap-grid size — must match MapCanvas's snapGrid ([20,20]) and mapStore's GRID.
const GRID = 20;
// Auto-placed systems always sit a consistent 3 grid squares clear of the
// system they're placed next to — rather than a node-width-dependent gap that
// drifted as the uniform-size max grew.
const PLACEMENT_GAP = 3 * GRID;
const ceilToGrid  = (n: number) => Math.ceil(n / GRID) * GRID;
const roundToGrid = (n: number) => Math.round(n / GRID) * GRID;

// Slots around the source, both clockwise (+y is down): cardinals first, then
// diagonals, scaled by `ring` for distance. The user's default-placement pref
// picks the starting cardinal direction; rotation continues clockwise from
// there. Legacy 'horizontal'/'vertical' settings map to east/south.
export type PlacementDirection = 'east' | 'south' | 'west' | 'north';

export function normalizePlacement(v: string | null | undefined): PlacementDirection {
  switch (v) {
    case 'south':
    case 'vertical': return 'south';
    case 'west':     return 'west';
    case 'north':    return 'north';
    default:         return 'east'; // 'east' / 'horizontal' / unset
  }
}

// Slot rings keyed by the preferred start: that cardinal first, then clockwise
// through the rest, diagonals last.
const OFFSETS_BY_DIR: Record<PlacementDirection, [number, number][]> = {
  east:  [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]],
  south: [[0, 1], [-1, 0], [0, -1], [1, 0], [-1, 1], [-1, -1], [1, -1], [1, 1]],
  west:  [[-1, 0], [0, -1], [1, 0], [0, 1], [-1, -1], [1, -1], [1, 1], [-1, 1]],
  north: [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]],
};
// Dense-map fallback: a single step in the preferred direction.
const FALLBACK_BY_DIR: Record<PlacementDirection, [number, number]> = {
  east: [1, 0], south: [0, 1], west: [-1, 0], north: [0, -1],
};

// Pick a position for a newly auto-added system by rotating clockwise around
// the system it was jumped from, starting in the preferred direction (right of
// the source when horizontal, below it when vertical), then the rest of the
// ring, then outward on wider rings. Each candidate is collision-checked
// against every node, so it also dodges unrelated systems sitting in a slot.
function findFreePosition(
  source: { x: number; y: number },
  systems: Box[],
  w: number,
  h: number,
  gap: number,
  direction: PlacementDirection,
  snap: boolean,
): { x: number; y: number } {
  const collides = (x: number, y: number) =>
    systems.some((s) => boxesOverlap(x, y, s.position.x, s.position.y, w, h, gap));

  // Grid-aligned step: a whole node footprint rounded up to the grid plus the
  // fixed gap, so spacing is consistent instead of drifting with node width.
  // When snap-to-grid is on, the final position is rounded onto the grid too.
  const place = (x: number, y: number) =>
    snap ? { x: roundToGrid(x), y: roundToGrid(y) } : { x, y };
  const offsets = OFFSETS_BY_DIR[direction];
  const stepX = ceilToGrid(w) + gap;
  const stepY = ceilToGrid(h) + gap;
  for (let ring = 1; ring <= 6; ring++) {
    for (const [dx, dy] of offsets) {
      const c = place(source.x + dx * ring * stepX, source.y + dy * ring * stepY);
      if (!collides(c.x, c.y)) return c;
    }
  }
  // Dense map — fall back to a single step in the preferred direction.
  const [fx, fy] = FALLBACK_BY_DIR[direction];
  return place(source.x + fx * stepX, source.y + fy * stepY);
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
    const { map, addSystem, addConnection, updateConnection, selectSystem, setCurrentSystem, uniformWidth, uniformHeight, snapToGrid } = useMapStore.getState();

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
      // Offset by the widest node seen so an auto-added system never overlaps
      // the one it's placed next to (positions are top-left corners). Falls back
      // to a generous constant before any node has been measured.
      const w = uniformWidth || 220;
      const h = uniformHeight || 120;
      const gap = PLACEMENT_GAP;
      // Anchor placement on the system we jumped from (or the map centroid for
      // the very first auto-add), then rotate clockwise around it into the
      // first free slot — right, below, left, above, diagonals, wider rings.
      let source: { x: number; y: number };
      if (prevMapSystemId) {
        source = map.systems.find((s) => s.id === prevMapSystemId)!.position;
      } else {
        source = {
          x: map.systems.length ? map.systems.reduce((sum, s) => sum + s.position.x, 0) / map.systems.length : 0,
          y: map.systems.length ? map.systems.reduce((sum, s) => sum + s.position.y, 0) / map.systems.length : 0,
        };
      }
      const direction = normalizePlacement(readUserSetting<string>('nexum.map.placement', 'east'));
      const position = findFreePosition(source, map.systems, w, h, gap, direction, snapToGrid);

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
      const existing = freshConnections.find(
        (c) =>
          (c.sourceId === prevMapSystemId && c.targetId === mapSystemId) ||
          (c.sourceId === mapSystemId && c.targetId === prevMapSystemId),
      );
      if (existing) {
        // Physically jumping the link is definitive proof it's live — if it was
        // quarantined (backing sig deleted), un-break it so the map stays honest.
        if (existing.broken) updateConnection(existing.id, { broken: false });
      } else {
        // Pick the optimal source/target sides from the two systems' actual
        // positions so the auto-added connection attaches cleanly — bottom→top
        // for a vertical layout, right→left for a horizontal one — instead of a
        // fixed right→left that cuts diagonally across vertically-stacked nodes.
        const placed = useMapStore.getState().map.systems;
        const srcPos = placed.find((s) => s.id === prevMapSystemId)?.position;
        const tgtPos = placed.find((s) => s.id === mapSystemId)?.position;
        const { sourceHandle, targetHandle } = srcPos && tgtPos
          ? pickHandles(srcPos, tgtPos)
          : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
        addConnection(prevMapSystemId, mapSystemId, sourceHandle, targetHandle);
      }
    }

    lastMapSystemId.current = mapSystemId;
    setCurrentSystem(mapSystemId);
    selectSystem(mapSystemId);
  }, [enabled, location, canEdit]);
}
