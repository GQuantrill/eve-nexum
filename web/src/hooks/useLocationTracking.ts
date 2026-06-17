import { useEffect, useRef } from 'react';
import { useMapStore, getNodeSize } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useCanEdit } from './useCanEdit';
import { readUserSetting } from './useUserSetting';
import { pickHandles } from '../components/map/edgeUtils';
import type { SystemClass, WormholeEffect } from '../types';

interface PlacedBox { id: string; position: { x: number; y: number } }
interface Size { w: number; h: number }

// Fallback footprint for nodes we can't measure (none reported yet) and as the
// candidate estimate when uniform sizing is off — collision against each node's
// real size does the precise dodging, so this only needs to be a sane nominal.
const DEFAULT_W = 220;
const DEFAULT_H = 120;

// AABB overlap test between two top-left-anchored boxes (each with its own w/h),
// padded by `gap`. Per-box dimensions let us pack against nodes' real sizes
// instead of treating every node as the single uniform max.
function boxesOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
  gap: number,
): boolean {
  return ax < bx + bw + gap && ax + aw + gap > bx && ay < by + bh + gap && ay + ah + gap > by;
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
  sourceSize: Size,
  candidate: Size,
  systems: PlacedBox[],
  sizeOf: (id: string) => Size | undefined,
  gap: number,
  direction: PlacementDirection,
  snap: boolean,
): { x: number; y: number } {
  // Collide the candidate's footprint against each existing node's *real*
  // measured size (uniform max when uniform sizing is on, natural size when
  // off) so small nodes don't reserve big-node margins and tall nodes still
  // get cleared. Unmeasured nodes fall back to the candidate footprint.
  const collides = (x: number, y: number) =>
    systems.some((s) => {
      const sz = sizeOf(s.id) ?? candidate;
      return boxesOverlap(x, y, candidate.w, candidate.h, s.position.x, s.position.y, sz.w, sz.h, gap);
    });

  // Step by the SOURCE node's footprint so the first ring always clears the
  // node we placed next to; spacing follows the real layout rather than the
  // single global max (which grew mid-run and gapped around small nodes).
  // When snap-to-grid is on, the final position is rounded onto the grid too.
  const place = (x: number, y: number) =>
    snap ? { x: roundToGrid(x), y: roundToGrid(y) } : { x, y };
  const offsets = OFFSETS_BY_DIR[direction];
  const stepX = ceilToGrid(sourceSize.w) + gap;
  const stepY = ceilToGrid(sourceSize.h) + gap;
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

export interface JumpSystem {
  eveSystemId: number;
  name:        string;
  systemClass: string;
  effect:      string;
  statics:     string[];
  regionName:  string | null;
  npcType:     string | null;
}

/**
 * Apply one "the player is now in `system`, arriving from `prevMapSystemId`"
 * jump to the active map: reuse the system if it's already placed, otherwise
 * auto-add it at the next free slot around the source (same clockwise
 * findFreePosition logic live tracking uses), then add or un-break the
 * connection. Returns the resulting map-system id, or null when the system
 * isn't on the map and `canAdd` is false (locked / no edit / tracking off).
 *
 * Shared by the live tracker below and `nexumDebug.simulateJumps`, so the
 * console debug tool drives the exact same placement code as a real jump.
 */
export function applyJump(system: JumpSystem, prevMapSystemId: string | null, canAdd: boolean): string | null {
  const { map, addSystem, addConnection, updateConnection, uniformSize, uniformWidth, uniformHeight, snapToGrid } = useMapStore.getState();

  let mapSystemId: string;
  const existing = map.systems.find((s) => s.eveSystemId === system.eveSystemId);
  if (existing) {
    mapSystemId = existing.id;
  } else {
    if (!canAdd) return null;
    // The new node hasn't rendered, so its real size is unknown. In uniform
    // mode every node is clamped to the same max, so estimate with that;
    // otherwise a nominal default — collision against each existing node's real
    // size handles the precise spacing.
    const candidate: Size = {
      w: uniformSize && uniformWidth  > 0 ? uniformWidth  : DEFAULT_W,
      h: uniformSize && uniformHeight > 0 ? uniformHeight : DEFAULT_H,
    };
    const gap = PLACEMENT_GAP;
    let source: { x: number; y: number };
    if (prevMapSystemId && map.systems.some((s) => s.id === prevMapSystemId)) {
      source = map.systems.find((s) => s.id === prevMapSystemId)!.position;
    } else {
      source = {
        x: map.systems.length ? map.systems.reduce((sum, s) => sum + s.position.x, 0) / map.systems.length : 0,
        y: map.systems.length ? map.systems.reduce((sum, s) => sum + s.position.y, 0) / map.systems.length : 0,
      };
    }
    // Clear the node we're placing next to: use its real measured size when we
    // have it, else the candidate estimate.
    const sourceSize: Size = (prevMapSystemId ? getNodeSize(prevMapSystemId) : undefined) ?? candidate;
    const direction = normalizePlacement(readUserSetting<string>('nexum.map.placement', 'east'));
    const position = findFreePosition(source, sourceSize, candidate, map.systems, getNodeSize, gap, direction, snapToGrid);
    mapSystemId = addSystem(system.name, system.systemClass as SystemClass, position, {
      eveSystemId: system.eveSystemId,
      effect:      system.effect as WormholeEffect,
      statics:     system.statics,
      regionName:  system.regionName,
      npcType:     system.npcType,
    });
  }

  if (canAdd && prevMapSystemId && prevMapSystemId !== mapSystemId && map.systems.some((s) => s.id === prevMapSystemId)) {
    const freshConnections = useMapStore.getState().map.connections;
    const existingConn = freshConnections.find(
      (c) =>
        (c.sourceId === prevMapSystemId && c.targetId === mapSystemId) ||
        (c.sourceId === mapSystemId && c.targetId === prevMapSystemId),
    );
    if (existingConn) {
      // Physically jumping the link is proof it's live — un-quarantine if broken.
      if (existingConn.broken) updateConnection(existingConn.id, { broken: false });
    } else {
      const placed = useMapStore.getState().map.systems;
      const srcPos = placed.find((s) => s.id === prevMapSystemId)?.position;
      const tgtPos = placed.find((s) => s.id === mapSystemId)?.position;
      const { sourceHandle, targetHandle } = srcPos && tgtPos
        ? pickHandles(srcPos, tgtPos)
        : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
      addConnection(prevMapSystemId, mapSystemId, sourceHandle, targetHandle);
    }
  }

  return mapSystemId;
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
    const { map, selectSystem, setCurrentSystem } = useMapStore.getState();

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

    // A locked map never grows from passive tracking, nor does one a readonly /
    // no-topology user is viewing; track-jumps off opts out of auto-add too.
    const trackJumps = useMapStore.getState().trackJumps;
    const canAdd = trackJumps && !map.locked && canEdit;
    const mapSystemId = applyJump(
      {
        eveSystemId: system.eveSystemId,
        name:        system.name,
        systemClass: system.systemClass,
        effect:      system.effect,
        statics:     system.statics,
        regionName:  system.regionName ?? null,
        npcType:     system.npcType ?? null,
      },
      prevMapSystemId,
      canAdd,
    );
    if (mapSystemId === null) {
      // Not on the map and not allowed to add — record nothing, just clear.
      lastMapSystemId.current = null;
      setCurrentSystem(null);
      return;
    }

    lastMapSystemId.current = mapSystemId;
    setCurrentSystem(mapSystemId);
    selectSystem(mapSystemId);
  }, [enabled, location, canEdit]);
}
