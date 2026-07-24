import { useEffect, useRef } from 'react';
import { useMapStore, getPlacementCell, registerPlacementFix } from '../store/mapStore';
import { useCharacterLocation } from './useCharacterLocation';
import { useCanEdit } from './useCanEdit';
import { readUserSetting } from './useUserSetting';
import { pickHandles } from '../components/map/edgeUtils';
import { maybeConfirmWhJump } from './whJumpConfirm';
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

export interface JumpSystem {
  eveSystemId: number;
  name:        string;
  systemClass: string;
  effect:      string;
  statics:     string[];
  regionName:  string | null;
  npcType:     string | null;
}

// K-space classes suppressed by the opt-in "don't track K-space" setting.
// Pochven is deliberately NOT here — it's wormhole-relevant, so it's always
// tracked like J-space.
const KSPACE_SKIP = new Set(['HS', 'LS', 'NS']);
const isKspaceSkip = (cls: string) => KSPACE_SKIP.has(cls);

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
  const { map, addSystem, addConnection, updateConnection, snapToGrid } = useMapStore.getState();

  let mapSystemId: string;
  const existing = map.systems.find((s) => s.eveSystemId === system.eveSystemId);
  if (existing) {
    mapSystemId = existing.id;
  } else {
    if (!canAdd) return null;
    // Placement cell = the largest full node footprint (height included), so
    // every cell fits any node and tiles with consistent 3-square gutters
    // regardless of the uniform-size toggle. Falls back to a nominal node size
    // before any node has been measured.
    const cell = getPlacementCell();
    const w = cell.w || 220;
    const h = cell.h || 120;
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
    const direction = normalizePlacement(readUserSetting<string>('nexum.map.placement', 'east'));
    const position = findFreePosition(source, map.systems, w, h, gap, direction, snapToGrid);
    mapSystemId = addSystem(system.name, system.systemClass as SystemClass, position, {
      eveSystemId: system.eveSystemId,
      effect:      system.effect as WormholeEffect,
      statics:     system.statics,
      regionName:  system.regionName,
      npcType:     system.npcType,
    });

    // If the node landed above/left of a real source, its true rendered size
    // (unknown here) may be larger than the placement cell assumed — which
    // would let it overlap the source. Schedule a one-shot gap fix that runs
    // once the node has measured. Only relevant when placed relative to an
    // actual source node (not the center-of-mass fallback).
    if (prevMapSystemId && map.systems.some((s) => s.id === prevMapSystemId)) {
      const fixY = position.y < source.y; // placed above the source
      const fixX = position.x < source.x; // placed left of the source
      if (fixY || fixX) registerPlacementFix(mapSystemId, prevMapSystemId, fixY, fixX);
    }
  }

  let jumpConnId: string | null = null;
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
      jumpConnId = existingConn.id;
    } else {
      const placed = useMapStore.getState().map.systems;
      const srcPos = placed.find((s) => s.id === prevMapSystemId)?.position;
      const tgtPos = placed.find((s) => s.id === mapSystemId)?.position;
      const { sourceHandle, targetHandle } = srcPos && tgtPos
        ? pickHandles(srcPos, tgtPos)
        : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
      jumpConnId = addConnection(prevMapSystemId, mapSystemId, sourceHandle, targetHandle);
    }
  }

  // A jump resolved — real tracking and the jump simulator both funnel through
  // here. If it crossed a wormhole (not a stargate — whJumpConfirm checks the
  // connection's gate classification), record where the source's hole leads.
  // Holes already pinned to a system are filtered out inside whJumpConfirm.
  if (jumpConnId && prevMapSystemId) {
    void maybeConfirmWhJump({
      mapId:           map.id,
      fromMapSystemId: prevMapSystemId,
      toEveSystemId:   system.eveSystemId,
      toClass:         system.systemClass,
      toName:          system.name,
      connId:          jumpConnId,
    });
  }

  return mapSystemId;
}

/**
 * One jump through the "don't track K-space" filter, funnelling to `applyJump`.
 * Shared by the live tracker AND `nexumDebug.simulateJumps`, so the simulator
 * reproduces exactly what real flying records.
 *
 * With `skipKspace` off it's a plain `applyJump`. With it on, only the K-space
 * systems bordering a J-space jump are recorded: the first entered from J-space,
 * and the last before jumping back into J-space (added retroactively here).
 * Intermediate K-space is dropped. Returns the resulting map-system id (or null
 * when nothing was recorded) plus how the caller should advance its connection
 * anchor: a node id, null (clear), or 'keep' (a skipped system must not become
 * the anchor). `prev` is the previous PHYSICAL system, mapped or not.
 */
export function applyTrackedJump(
  curr: JumpSystem,
  prev: JumpSystem | null,
  prevMapSystemId: string | null,
  opts: { skipKspace: boolean; canAdd: boolean },
): { mapSystemId: string | null; anchor: string | null | 'keep' } {
  const skip = opts.skipKspace && opts.canAdd;
  const systems = () => useMapStore.getState().map.systems;

  if (skip && isKspaceSkip(curr.systemClass)) {
    // Arriving in K-space: keep it only when jumping in FROM J-space (the first
    // K-space of this excursion). Intermediate K-space, or a login already
    // parked in K-space, is skipped.
    const fromJspace = prev !== null && !isKspaceSkip(prev.systemClass);
    if (fromJspace) {
      const mapSystemId = applyJump(curr, prevMapSystemId, true);
      return { mapSystemId, anchor: mapSystemId };
    }
    return { mapSystemId: systems().find((s) => s.eveSystemId === curr.eveSystemId)?.id ?? null, anchor: 'keep' };
  }

  if (skip && prev !== null && isKspaceSkip(prev.systemClass)) {
    // Arriving in J-space (or Pochven) from K-space: record the K-space system
    // we jumped from — retroactively if it was skipped — and link it to here.
    const prevOnMap = systems().find((s) => s.eveSystemId === prev.eveSystemId)?.id ?? null;
    const source = prevOnMap ?? applyJump(prev, null, true); // add the last K-space isolated
    const mapSystemId = applyJump(curr, source, true);       // then connect it through
    return { mapSystemId, anchor: mapSystemId };
  }

  const mapSystemId = applyJump(curr, prevMapSystemId, opts.canAdd);
  return { mapSystemId, anchor: mapSystemId };
}

/**
 * Map-side reaction to character location changes. The actual polling lives
 * in `useCharacterLocation` (10s, module-level, shared with the sidebar);
 * this hook just runs map-mutation side-effects whenever the location data
 * advances and a map is active.
 */
export function useLocationTracking(enabled: boolean) {
  const location = useCharacterLocation();
  const followedId = useMapStore((s) => s.routeOrigin?.charId ?? null);
  const canEdit  = useCanEdit();
  const lastEveSystemId = useRef<number | null>(null);
  const lastMapSystemId = useRef<string | null>(null);
  const lastActiveMapId = useRef<string | null>(null);
  // The character we were following on the last pass. Switching the followed
  // character must reset the jump refs (see below) so the new character's
  // current system isn't drawn as a jump FROM the previous character's system.
  const lastFollowedId = useRef<number | null>(null);
  // The pilot's previous PHYSICAL system (whether or not it was recorded on the
  // map). Needed for the "don't track K-space" option, which has to look at the
  // departure system's class — and retroactively add the last K-space system
  // when the pilot jumps from it into J-space.
  const prevPhysical = useRef<JumpSystem | null>(null);
  // The eve system we last auto-selected. Guards the "follow the character"
  // selection so it fires only on a GENUINE move — not when ESI's online flag
  // flickers (which resets lastEveSystemId and would otherwise re-select the
  // same system, yanking the user off whatever they'd manually clicked).
  const lastSelectedEveId = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const { map, selectSystem, setCurrentSystem } = useMapStore.getState();

    // No active map loaded yet (mid switchMap / first paint) — wait for the
    // next location update rather than racing addSystem against an empty store.
    if (!map.id) return;

    // Reset refs when the active map changes OR the followed character changes.
    // A new followed character's current system must not be linked back to the
    // previous character's last system (a bogus cross-character connection).
    if (map.id !== lastActiveMapId.current || followedId !== lastFollowedId.current) {
      lastActiveMapId.current = map.id;
      lastFollowedId.current = followedId;
      lastEveSystemId.current = null;
      lastMapSystemId.current = null;
      lastSelectedEveId.current = null;
      prevPhysical.current = null;
    }

    const system = location.system;
    if (!location.online || !system) {
      lastEveSystemId.current = null;
      lastMapSystemId.current = null;
      prevPhysical.current = null;
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

    const curr: JumpSystem = {
      eveSystemId: system.eveSystemId,
      name:        system.name,
      systemClass: system.systemClass,
      effect:      system.effect,
      statics:     system.statics,
      regionName:  system.regionName ?? null,
      npcType:     system.npcType ?? null,
    };
    const prev = prevPhysical.current;
    prevPhysical.current = curr; // remember the physical location for the next jump

    // When this tab follows a PINNED character (a routeOrigin override, not the
    // session-active one), keep that override's location live as they fly — so
    // route calcs and centring track their current system, not the pin-time
    // snapshot. Only the location fields change; charId / name are preserved.
    if (followedId != null) {
      const ro = useMapStore.getState().routeOrigin;
      if (ro && ro.charId === followedId) {
        useMapStore.getState().setRouteOrigin({
          ...ro,
          eveSystemId: system.eveSystemId,
          systemName:  system.name,
          systemClass: system.systemClass,
        });
      }
    }

    // A locked map never grows from passive tracking, nor does one a readonly /
    // no-topology user is viewing; track-jumps off opts out of auto-add too.
    const trackJumps = useMapStore.getState().trackJumps;
    const canAdd = trackJumps && !map.locked && canEdit;
    const skipKspace = readUserSetting<boolean>('nexum.tracking.skipKspace', false);

    const { mapSystemId, anchor } = applyTrackedJump(curr, prev, prevMapSystemId, { skipKspace, canAdd });
    if (anchor !== 'keep') lastMapSystemId.current = anchor;

    if (mapSystemId === null) {
      // On an untracked system (skipped K-space, or can't-add and not on map).
      setCurrentSystem(null);
      return;
    }

    setCurrentSystem(mapSystemId);
    // Follow the character onto the new system only when it's genuinely a
    // different system than the one we last auto-selected. An ESI online-status
    // flicker resets lastEveSystemId (above), which would otherwise re-run this
    // for the SAME system and steal a selection the user made by hand.
    if (system.eveSystemId !== lastSelectedEveId.current) {
      lastSelectedEveId.current = system.eveSystemId;
      selectSystem(mapSystemId, { fromJump: true });
    }
  }, [enabled, location, canEdit, followedId]);
}
