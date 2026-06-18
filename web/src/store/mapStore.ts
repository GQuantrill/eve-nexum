import { create } from 'zustand';
import { readUserSetting, writeUserSetting } from '../hooks/useUserSetting';
import { v4 as uuid } from 'uuid';
import { api } from '../api/client';
import { enqueue } from './pendingQueue';
import { toast } from '../components/ui/Toaster';
import type { WormholeMap, MapSystem, MapConnection, SavedRoute, SystemClass, WormholeEffect } from '../types';
import { pickHandles } from '../components/map/edgeUtils';

// Another of the account's characters chosen as the route/centre origin.
export interface RouteOriginOverride {
  charId:        number;          // users.id of the reference character
  characterName: string;
  eveSystemId:   number;          // the system to route from / centre on
  systemName:    string;
  systemClass:   string | null;   // for the k-space gate in useRouteOrigin
}

// Debounce position saves — fires max once per 500 ms per system
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Per-node measured dimensions, kept out of reactive state so individual
// ResizeObserver fires don't trigger re-renders across the whole map.
// `countHeight` is false for systems with statics — those WH systems can
// be 6× taller than a K-space node and would otherwise force every node
// to that height in uniform mode. The width max still considers them so
// long J-codes / station names participate as expected.
const nodeSizes = new Map<string, { w: number; h: number; countHeight: boolean }>();
// Snap-grid size — must match MapCanvas's snapGrid. Uniform node dimensions are
// rounded UP to whole grid squares so that, with the top-left snapped to the
// grid, the bottom-right edge lands on a grid line too (nodes tile cleanly and
// don't finish part-way through a square). Border-box is global, so a min-width
// of N renders an N-px outer box.
const GRID = 20;
const snapUpToGrid = (n: number) => (n > 0 ? Math.ceil(n / GRID) * GRID : 0);
const roundToGrid  = (n: number) => Math.round(n / GRID) * GRID;
const PLACEMENT_GAP = 3 * GRID; // keep in sync with useLocationTracking

// One-shot post-measure placement fixes. A node auto-placed *above* or *left*
// of its source can overlap it once it renders taller/wider than the placement
// cell knew at the time (a brand-new max not yet measured — e.g. the first
// statics-heavy WH node). Keyed by node id and consumed on first measure in
// reportNodeSize, which nudges it back to the 3-square gap using its real size.
const placementFixes = new Map<string, { sourceId: string; fixY: boolean; fixX: boolean }>();
export function registerPlacementFix(nodeId: string, sourceId: string, fixY: boolean, fixX: boolean): void {
  placementFixes.set(nodeId, { sourceId, fixY, fixX });
}

// Largest *full* node footprint seen so far (width and height, ungated by
// countHeight), snapped up to the grid. This is the auto-placement cell: unlike
// the uniform-size max — which excludes tall static nodes from the height so it
// doesn't force every node tall — placement needs a cell big enough for ANY
// node, so cells tile with consistent 3-square gutters and nothing overflows
// into its neighbour. Returns {0,0} until at least one node has reported a size.
export function getPlacementCell(): { w: number; h: number } {
  let w = 0, h = 0;
  for (const s of nodeSizes.values()) {
    if (s.w > w) w = s.w;
    if (s.h > h) h = s.h;
  }
  return { w: snapUpToGrid(w), h: snapUpToGrid(h) };
}

function recomputeUniformMax(): { w: number; h: number } {
  let w = 0, h = 0, hAll = 0;
  let anyHeightEligible = false;
  for (const s of nodeSizes.values()) {
    if (s.w > w) w = s.w;
    if (s.h > hAll) hAll = s.h;
    if (s.countHeight) {
      anyHeightEligible = true;
      if (s.h > h) h = s.h;
    }
  }
  // Fall back to the global max if every node has statics — without this
  // the height would lock at 0 and the inline minHeight would never apply.
  return { w: snapUpToGrid(w), h: snapUpToGrid(anyHeightEligible ? h : hAll) };
}
// Debounce map name saves — keyed by mapId so two tabs renaming two different
// maps don't clobber each other through a shared timer slot.
const nameTimers = new Map<string, ReturnType<typeof setTimeout>>();

function syncMove(mapId: string, systemId: string, position: { x: number; y: number }) {
  const key = `${mapId}:${systemId}`;
  clearTimeout(moveTimers.get(key));
  moveTimers.set(key, setTimeout(() => {
    api(`/api/maps/${mapId}/systems/${systemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ position }),
    }).catch(console.error);
    moveTimers.delete(key);
  }, 500));
}

// Placeholder used before any map is loaded. `id: ''` is the unloaded
// sentinel — guards everywhere check `!map.id` / `!activeMapId` before
// writing. Switching to `null` would cascade type changes through every
// consumer of WormholeMap, so we keep the empty string and centralise the
// check here.
const emptyMap = (): WormholeMap => ({
  id: '', name: '', systems: [], connections: [], routes: [],
  createdAt: '', updatedAt: '',
});

export interface MapListItem {
  id: string;
  name: string;
  isCorpMap: boolean;
  /** True when this map isn't owned by the caller and isn't a corp map they
   *  belong to — i.e. it reached their list via an explicit map_shares grant. */
  sharedWithMe?: boolean;
  locked: boolean;
  /** Owning character's name — shown in the merge picker to disambiguate maps. */
  ownerName?: string | null;
  /** Corp maps only: opted in as a merge *source* by a full/admin member. */
  allowAsMergeSource?: boolean;
  /** Corp maps only: opted in as a merge *destination* by a full/admin member. */
  allowAsMergeDestination?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UndoCommand =
  | { type: 'add_system';       systemId: string }
  | { type: 'remove_system';    system: MapSystem; connections: MapConnection[] }
  | { type: 'move_system';      systemId: string; prevPosition: { x: number; y: number } }
  | { type: 'update_system';    systemId: string; prev: Partial<MapSystem> }
  | { type: 'add_connection';   connectionId: string }
  | { type: 'remove_connection'; connection: MapConnection }
  | { type: 'update_connection'; connectionId: string; prev: Partial<MapConnection> }
  | { type: 'batch';            commands: UndoCommand[] };

const MAX_UNDO = 50;

// Per-system scanned content for the content filter. sigTypes/anomTypes are the
// distinct type strings present; names are all sig + anomaly site names,
// lowercased for substring search.
export interface SystemContent {
  sigTypes:  string[];
  anomTypes: string[];
  names:     string[];
}

export interface ContentFilter {
  sigTypes:  string[];
  anomTypes: string[];
  nameQuery: string;
}

interface MapStore {
  // Maps list
  maps: MapListItem[];
  maxMaps: number;
  maxCorpMaps: number;
  corpMapCount: number;
  activeMapId: string | null;

  // Current map
  map: WormholeMap;
  selectedSystemId: string | null;
  selectedConnectionId: string | null;
  currentSystemId: string | null;
  snapToGrid: boolean;
  compactMode: boolean;
  showMinimap: boolean;
  uniformSize: boolean;
  showStatics: boolean;
  connectionThickness: 'thin' | 'standard' | 'thick' | 'extra';
  routeMode: 'shortest' | 'secure';
  uiZoom: number;
  trackJumps: boolean;
  // Largest natural node dimensions seen so far — used as the min-width /
  // min-height for every node when uniformSize is on. Each SystemNode
  // reports its rendered size via reportNodeSize; the store keeps a Map
  // keyed by node id and recomputes the max on every update.
  uniformWidth:  number;
  uniformHeight: number;
  reportNodeSize: (id: string, width: number, height: number, countHeight: boolean) => void;
  forgetNodeSize: (id: string) => void;
  resetUniformSizes: () => void;
  easyConnect: boolean;
  mapOptionsOpen: boolean;
  edgeStyle: 'bezier' | 'straight' | 'smoothstep';
  autoLayoutPending: boolean;
  requestAutoLayout: () => void;
  clearAutoLayoutPending: () => void;
  // Signals the canvas to fit/centre the whole map in view (e.g. after a
  // region seed). Mirrors the autoLayout flag pattern.
  fitViewPending: boolean;
  requestFitView: () => void;
  clearFitView: () => void;

  // EVE system id the map should centre/zoom on (e.g. clicking the pilot's
  // location in the toolbar). MapCanvas consumes + clears it. null = no request.
  centerRequestEveId: number | null;
  requestCenterOnEveSystem: (eveSystemId: number) => void;
  // Map node id to centre/zoom on (e.g. the watchlist "show on map" button).
  // Distinct from the eve-id request so it works for custom systems too.
  centerRequestNodeId: string | null;
  requestCenterOnNode: (nodeId: string) => void;
  clearCenterRequest: () => void;

  // Route/centre origin override: point jump calcs + centring at another of
  // the account's characters (e.g. a scout on the chain exit) instead of the
  // active character. null = use the active character's live location.
  routeOrigin: RouteOriginOverride | null;
  setRouteOrigin: (o: RouteOriginOverride | null) => void;

  // Undo
  undoStack: UndoCommand[];
  pushUndo: (cmd: UndoCommand) => void;
  undo: () => Promise<void>;

  panelOrder: string[];
  applyPreferences: (prefs: { compactMode: boolean; snapToGrid: boolean; showMinimap: boolean; uniformSize: boolean; showStatics: boolean; easyConnect: boolean; connectionThickness: string; routeMode: string; uiZoom: number; panelOrder: string[] }) => void;
  setPanelOrder: (order: string[]) => void;
  setShowMinimap: (v: boolean) => void;
  setUniformSize: (v: boolean) => void;
  setShowStatics: (v: boolean) => void;
  setConnectionThickness: (v: 'thin' | 'standard' | 'thick' | 'extra') => void;
  setRouteMode: (v: 'shortest' | 'secure') => void;
  setUiZoom: (v: number) => void;
  setTrackJumps: (v: boolean) => void;
  setEasyConnect: (v: boolean) => void;
  setMapOptionsOpen: (v: boolean) => void;
  setEdgeStyle: (v: MapStore['edgeStyle']) => void;
  setCurrentSystem: (id: string | null) => void;

  // Maps management
  loadMaps: () => Promise<void>;
  switchMap: (id: string) => Promise<void>;
  createMap: (name?: string, isCorpMap?: boolean) => Promise<void>;
  createFromRegion: (regionId: number, name: string, isCorpMap: boolean) => Promise<void>;
  deleteMap: (id: string) => Promise<void>;

  // Map metadata
  setMapName: (name: string) => void;
  setSnapToGrid: (v: boolean) => void;
  setCompactMode: (v: boolean) => void;

  // Systems
  addSystem: (
    name: string,
    systemClass: SystemClass,
    position: { x: number; y: number },
    opts?: { eveSystemId?: number | null; effect?: WormholeEffect; statics?: string[]; regionName?: string | null; npcType?: string | null },
  ) => string;
  updateSystem: (id: string, updates: Partial<Omit<MapSystem, 'id'>>, opts?: { skipUndo?: boolean }) => void;
  removeSystem: (id: string) => void;
  lockSystem: (id: string) => void;
  moveSystem: (id: string, position: { x: number; y: number }, opts?: { skipUndo?: boolean }) => void;

  // Connections
  addConnection: (sourceId: string, targetId: string, sourceHandle?: string | null, targetHandle?: string | null) => string;
  updateConnection: (id: string, updates: Partial<Omit<MapConnection, 'id'>>) => void;
  removeConnection: (id: string) => void;
  // Re-route every connection's handles to the nearest sides given current
  // node positions. Used by the sidebar button and after a region seed.
  optimizeConnections: () => void;

  // Saved chains (map-scoped, named recorded paths). addRoute returns the new
  // id, or null if the path is too short to save.
  addRoute: (name: string, systemIds: string[], connectionIds: string[]) => string | null;
  renameRoute: (id: string, name: string) => void;
  removeRoute: (id: string) => void;

  // Selection
  selectSystem: (id: string | null) => void;
  selectConnection: (id: string | null) => void;

  // Per-system revision counters bumped when a remote client changes that
  // system's signatures/structures. The open pane watches its system's value
  // and re-fetches when it ticks (sigs/structures live in pane state, not here).
  sigRev: Record<string, number>;
  structRev: Record<string, number>;
  anomRev: Record<string, number>;

  // Map-wide index of scanned wormhole-signature types per system (uppercased
  // wh_type codes), so the watchlist can match a scanned sig anywhere in the
  // chain — not just connections/statics. Loaded in bulk on map switch and
  // kept fresh by the open sig pane + remote sig.changed events.
  sigTypesBySystem: Record<string, string[]>;
  setSigTypesBulk: (next: Record<string, string[]>) => void;
  setSystemSigTypes: (systemId: string, types: string[]) => void;

  // Map-wide content index per system for the content filter: the set of
  // signature types and anomaly types present, plus all site names (lowercased
  // for substring search). Loaded alongside the sig-type index.
  contentBySystem: Record<string, SystemContent>;
  setContentBulk: (next: Record<string, SystemContent>) => void;

  // Transient (not persisted) content filter. A system "matches" if it has any
  // selected sig/anom type or a name containing the query; non-matching nodes
  // fade. Empty on all three = filter off.
  contentFilter: ContentFilter;
  setContentFilter: (next: Partial<ContentFilter>) => void;
  clearContentFilter: () => void;

  // Realtime: apply an edit pushed from another client (no persist, no undo).
  applyRemote: (event: RemoteEvent) => void;
}

// Events pushed over the live map stream. Mirror the server's publishToMap
// payloads in server/src/routes/maps.ts.
export type RemoteEvent =
  | { type: 'system.add';        system: MapSystem }
  | { type: 'system.update';     id: string; updates: Partial<MapSystem> }
  | { type: 'system.remove';     id: string }
  | { type: 'connection.add';    connection: MapConnection }
  | { type: 'connection.update'; id: string; updates: Partial<MapConnection> }
  | { type: 'connection.remove'; id: string }
  | { type: 'route.add';         route: SavedRoute }
  | { type: 'route.update';      id: string; updates: Partial<SavedRoute> }
  | { type: 'route.remove';      id: string }
  | { type: 'map.meta';          name?: string; locked?: boolean }
  | { type: 'map.resync' }
  | { type: 'sig.changed';       systemId: string }
  | { type: 'structure.changed'; systemId: string }
  | { type: 'anom.changed';      systemId: string };

export const useMapStore = create<MapStore>()((set, get) => {

  async function applyUndo(cmd: UndoCommand): Promise<void> {
    const { activeMapId } = get();
    if (!activeMapId) return;

    switch (cmd.type) {
      case 'add_system': {
        set((s) => ({
          selectedSystemId: s.selectedSystemId === cmd.systemId ? null : s.selectedSystemId,
          map: {
            ...s.map,
            systems: s.map.systems.filter((sys) => sys.id !== cmd.systemId),
            connections: s.map.connections.filter(
              (c) => c.sourceId !== cmd.systemId && c.targetId !== cmd.systemId,
            ),
          },
        }));
        await api(`/api/maps/${activeMapId}/systems/${cmd.systemId}`, { method: 'DELETE' }).catch(console.error);
        break;
      }

      case 'remove_system': {
        set((s) => {
          const restoredIds = new Set([...s.map.systems.map((sys) => sys.id), cmd.system.id]);
          const validConns = cmd.connections.filter(
            (c) =>
              restoredIds.has(c.sourceId) &&
              restoredIds.has(c.targetId) &&
              !s.map.connections.some((e) => e.id === c.id),
          );
          return {
            map: {
              ...s.map,
              systems: [...s.map.systems, cmd.system],
              connections: [...s.map.connections, ...validConns],
            },
          };
        });
        // System has to land first so connection FKs resolve; the connections
        // themselves are independent and can race in parallel.
        await api(`/api/maps/${activeMapId}/systems`, {
          method: 'POST',
          body: JSON.stringify({ ...cmd.system }),
        }).catch(console.error);
        await Promise.all(cmd.connections.map((conn) =>
          api(`/api/maps/${activeMapId}/connections`, {
            method: 'POST',
            body: JSON.stringify({ ...conn }),
          }).catch(console.error),
        ));
        break;
      }

      case 'move_system': {
        set((s) => ({
          map: {
            ...s.map,
            systems: s.map.systems.map((sys) =>
              sys.id === cmd.systemId ? { ...sys, position: cmd.prevPosition } : sys,
            ),
          },
        }));
        await api(`/api/maps/${activeMapId}/systems/${cmd.systemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ position: cmd.prevPosition }),
        }).catch(console.error);
        break;
      }

      case 'update_system': {
        set((s) => ({
          map: {
            ...s.map,
            systems: s.map.systems.map((sys) =>
              sys.id === cmd.systemId ? { ...sys, ...cmd.prev } : sys,
            ),
          },
        }));
        await api(`/api/maps/${activeMapId}/systems/${cmd.systemId}`, {
          method: 'PATCH',
          body: JSON.stringify(cmd.prev),
        }).catch(console.error);
        break;
      }

      case 'add_connection': {
        set((s) => ({
          selectedConnectionId: s.selectedConnectionId === cmd.connectionId ? null : s.selectedConnectionId,
          map: {
            ...s.map,
            connections: s.map.connections.filter((c) => c.id !== cmd.connectionId),
          },
        }));
        await api(`/api/maps/${activeMapId}/connections/${cmd.connectionId}`, { method: 'DELETE' }).catch(console.error);
        break;
      }

      case 'remove_connection': {
        set((s) => ({
          map: {
            ...s.map,
            connections: [...s.map.connections, cmd.connection],
          },
        }));
        await api(`/api/maps/${activeMapId}/connections`, {
          method: 'POST',
          body: JSON.stringify({ ...cmd.connection }),
        }).catch(console.error);
        break;
      }

      case 'update_connection': {
        set((s) => ({
          map: {
            ...s.map,
            connections: s.map.connections.map((c) =>
              c.id === cmd.connectionId ? { ...c, ...cmd.prev } : c,
            ),
          },
        }));
        await api(`/api/maps/${activeMapId}/connections/${cmd.connectionId}`, {
          method: 'PATCH',
          body: JSON.stringify(cmd.prev),
        }).catch(console.error);
        break;
      }

      case 'batch': {
        for (const subCmd of [...cmd.commands].reverse()) {
          await applyUndo(subCmd);
        }
        break;
      }
    }
  }

  return {
    maps: [],
    maxMaps: 10,
    maxCorpMaps: 5,
    corpMapCount: 0,
    activeMapId: null,
    map: emptyMap(),
    selectedSystemId: null,
    selectedConnectionId: null,
    currentSystemId: null,
    snapToGrid: false,
    compactMode: false,
    showMinimap: true,
    uniformSize: true,
    showStatics: true,
    connectionThickness: 'standard',
    routeMode:   'shortest',
    uiZoom: 1,
    // Initial value is read from localStorage (pre-hydration) and then
    // updated by the user-settings hydrate when /auth/me arrives. The
    // setter writes through to both, keeping cross-tab + cross-device.
    trackJumps:  readUserSetting<boolean>('nexum.trackJumps', true),
    uniformWidth:  0,
    uniformHeight: 0,
    easyConnect: false,
    mapOptionsOpen: false,
    edgeStyle: 'bezier',
    autoLayoutPending: false,
    fitViewPending: false,
    centerRequestEveId: null,
    centerRequestNodeId: null,
    routeOrigin: null,
    sigRev: {},
    structRev: {},
    anomRev: {},
    sigTypesBySystem: {},
    setSigTypesBulk: (next) => set({ sigTypesBySystem: next }),
    setSystemSigTypes: (systemId, types) => set((s) => ({
      sigTypesBySystem: { ...s.sigTypesBySystem, [systemId]: types },
    })),
    contentBySystem: {},
    setContentBulk: (next) => set({ contentBySystem: next }),
    contentFilter: { sigTypes: [], anomTypes: [], nameQuery: '' },
    setContentFilter: (next) => set((s) => ({ contentFilter: { ...s.contentFilter, ...next } })),
    clearContentFilter: () => set({ contentFilter: { sigTypes: [], anomTypes: [], nameQuery: '' } }),
    panelOrder: ['activity', 'killboard', 'notes', 'signatures', 'anomalies', 'structures', 'npcStations'],
    undoStack: [],

    pushUndo: (cmd) =>
      set((s) => ({ undoStack: [...s.undoStack.slice(-(MAX_UNDO - 1)), cmd] })),

    undo: async () => {
      const { undoStack } = get();
      if (undoStack.length === 0) return;
      const cmd = undoStack[undoStack.length - 1];
      set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
      await applyUndo(cmd);
    },

    applyPreferences: ({ compactMode, snapToGrid, showMinimap, uniformSize, showStatics, easyConnect, connectionThickness, routeMode, uiZoom, panelOrder }) => {
      // Whitelist of valid panel keys. `standings` was briefly a panel here
      // — kept in the filter so any persisted occurrence is silently
      // dropped on load now that standings live inline in the sov section.
      const all = ['activity', 'killboard', 'notes', 'signatures', 'anomalies', 'structures', 'npcStations'];
      const merged = [
        ...panelOrder.filter((p) => all.includes(p)),
        ...all.filter((p) => !panelOrder.includes(p)),
      ];
      const VALID_THICK = new Set(['thin', 'standard', 'thick', 'extra']);
      const safeThickness = (VALID_THICK.has(connectionThickness) ? connectionThickness : 'standard') as 'thin' | 'standard' | 'thick' | 'extra';
      const VALID_ROUTE = new Set(['shortest', 'secure']);
      const safeRouteMode = (VALID_ROUTE.has(routeMode) ? routeMode : 'shortest') as 'shortest' | 'secure';
      const safeZoom = Number.isFinite(uiZoom) ? Math.min(1.5, Math.max(0.8, uiZoom)) : 1;
      set({ compactMode, snapToGrid, showMinimap, uniformSize, showStatics, easyConnect, connectionThickness: safeThickness, routeMode: safeRouteMode, uiZoom: safeZoom, panelOrder: merged });
    },

    setPanelOrder: (order) => {
      set({ panelOrder: order });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ panelOrder: order }) }).catch(console.error);
    },

    // ── Maps management ───────────────────────────────────────────────────────

    loadMaps: async () => {
      const { maps, maxMaps, maxCorpMaps, corpMapCount } = await api<{ maps: MapListItem[]; maxMaps: number; maxCorpMaps: number; corpMapCount: number }>('/api/maps');
      const activeId = get().activeMapId;
      set({ maps, maxMaps, maxCorpMaps, corpMapCount });

      // Pick an initial map if none is active yet, falling back to the
      // user's last-viewed id when it's still in the list.
      if (maps.length > 0 && !activeId) {
        const savedId = localStorage.getItem('nexum.lastMapId');
        const target = savedId && maps.find((m) => m.id === savedId) ? savedId : maps[0].id;
        await get().switchMap(target);
        return;
      }

      // Revocation detection: if the active map vanished from the list
      // since last refresh, the owner has revoked the user's grant (or
      // deleted the map). Toast and switch to whatever's still available.
      if (activeId && !maps.find((m) => m.id === activeId)) {
        toast.info('Your access to that map was revoked');
        if (maps.length > 0) {
          await get().switchMap(maps[0].id);
        } else {
          set({ map: emptyMap(), activeMapId: null });
          localStorage.removeItem('nexum.lastMapId');
        }
      }
    },

    switchMap: async (id) => {
      // Cancel pending writes from the outgoing map — otherwise a debounced
      // rename or position-save fires against the next map after switch.
      for (const t of nameTimers.values()) clearTimeout(t);
      nameTimers.clear();
      for (const t of moveTimers.values()) clearTimeout(t);
      moveTimers.clear();

      try {
        const map = await api<WormholeMap>(`/api/maps/${id}`);
        // Older payloads / share responses may omit routes — normalise so the
        // chains slice can always read an array.
        if (!Array.isArray(map.routes)) map.routes = [];
        localStorage.setItem('nexum.lastMapId', id);
        set({ map, activeMapId: id, selectedSystemId: null, selectedConnectionId: null, currentSystemId: null, undoStack: [], sigTypesBySystem: {}, contentBySystem: {}, contentFilter: { sigTypes: [], anomTypes: [], nameQuery: '' } });
      } catch (err) {
        // 403/404 — the grant was revoked, or the map was deleted. Reload
        // the list (which will trigger the revocation-detection path above
        // if the active map really is gone) and bail out of the switch.
        const msg = err instanceof Error ? err.message : '';
        if (/→ 40[34]/.test(msg)) {
          await get().loadMaps();
          return;
        }
        throw err;
      }
    },

    createMap: async (name = 'New Map', isCorpMap = false) => {
      const { id } = await api<{ id: string }>('/api/maps', {
        method: 'POST',
        body: JSON.stringify({ name, isCorpMap }),
      });
      await get().loadMaps();
      await get().switchMap(id);
    },

    createFromRegion: async (regionId, name, isCorpMap) => {
      const { id } = await api<{ id: string }>('/api/maps/from-region', {
        method: 'POST',
        body: JSON.stringify({ regionId, name, isCorpMap }),
      });
      await get().loadMaps();
      await get().switchMap(id);
      // The position2D layout already places stargate-connected systems
      // adjacent (like the in-game map / Dotlan), so we deliberately do NOT run
      // the overlap-spread here — it would push connected systems apart and
      // undo that. Just re-route connection handles to the seeded positions and
      // fit the whole region in view. Deferred so the canvas has mounted the
      // freshly-seeded nodes first. (Users can still hit "Spread Nodes"
      // manually if a region renders too tightly.)
      setTimeout(() => {
        get().optimizeConnections();
        get().requestFitView();
      }, 500);
    },

    deleteMap: async (id) => {
      await api(`/api/maps/${id}`, { method: 'DELETE' });
      const remaining = get().maps.filter((m) => m.id !== id);
      set({ maps: remaining });
      if (get().activeMapId === id) {
        if (remaining.length > 0) {
          await get().switchMap(remaining[0].id);
        } else {
          set({ map: emptyMap(), activeMapId: null });
        }
      }
    },

    // ── Map metadata ──────────────────────────────────────────────────────────

    setMapName: (name) => {
      const { activeMapId } = get();
      // Mirror the rename into the maps list so the toolbar dropdown (which
      // renders from `maps`, not the active `map`) updates immediately.
      set((s) => ({
        map:  { ...s.map, name },
        maps: s.maps.map((m) => (m.id === activeMapId ? { ...m, name } : m)),
      }));
      if (!activeMapId) return;
      const existing = nameTimers.get(activeMapId);
      if (existing) clearTimeout(existing);
      nameTimers.set(activeMapId, setTimeout(() => {
        nameTimers.delete(activeMapId);
        api(`/api/maps/${activeMapId}`, { method: 'PATCH', body: JSON.stringify({ name }) }).catch(console.error);
      }, 800));
    },

    setSnapToGrid: (v) => {
      set({ snapToGrid: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ snapToGrid: v }) }).catch(console.error);
    },

    setCompactMode: (v) => {
      set({ compactMode: v });
      // Compact mode changes every node's natural size, so the cached
      // measurements (and the uniform-size max derived from them) are stale.
      // Without this, uniform mode ratchets up: toggling compact off grows the
      // nodes, and the inflated min keeps them measuring big when compact comes
      // back on. Reset forces a clean re-measure of the natural sizes.
      get().resetUniformSizes();
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ compactMode: v }) }).catch(console.error);
    },

    setShowMinimap: (v) => {
      set({ showMinimap: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ showMinimap: v }) }).catch(console.error);
    },

    setUniformSize: (v) => {
      set({ uniformSize: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ uniformSize: v }) }).catch(console.error);
    },

    setShowStatics: (v) => {
      set({ showStatics: v });
      // Same as compact mode: showing/hiding statics changes WH nodes' natural
      // height (and which nodes count toward the uniform max), so re-measure.
      get().resetUniformSizes();
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ showStatics: v }) }).catch(console.error);
    },

    setConnectionThickness: (v) => {
      set({ connectionThickness: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ connectionThickness: v }) }).catch(console.error);
    },

    setRouteMode: (v) => {
      set({ routeMode: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ routeMode: v }) }).catch(console.error);
    },

    setUiZoom: (v) => {
      const clamped = Math.min(1.5, Math.max(0.8, Number.isFinite(v) ? v : 1));
      set({ uiZoom: clamped });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ uiZoom: clamped }) }).catch(console.error);
    },

    setTrackJumps: (v) => {
      set({ trackJumps: v });
      writeUserSetting('nexum.trackJumps', v);
    },

    reportNodeSize: (id, width, height, countHeight) => {
      // Round + dedupe: ResizeObserver fires sub-pixel updates we don't
      // care about; ignore changes smaller than 1px on either axis and a
      // flag change that doesn't move dimensions.
      const prev = nodeSizes.get(id);
      if (prev
          && Math.abs(prev.w - width) < 1
          && Math.abs(prev.h - height) < 1
          && prev.countHeight === countHeight) return;
      nodeSizes.set(id, { w: width, h: height, countHeight });
      const { w, h } = recomputeUniformMax();
      const cur = get();
      if (cur.uniformWidth !== w || cur.uniformHeight !== h) {
        set({ uniformWidth: w, uniformHeight: h });
      }

      // Consume a pending placement fix now we know this node's real size.
      // Only ever moves the node FARTHER from the source (restores the gap when
      // it overlapped); a node already clear of the source is left where the
      // lattice put it, so aligned small nodes are untouched.
      const fix = placementFixes.get(id);
      if (fix) {
        placementFixes.delete(id);
        const st  = get();
        const node = st.map.systems.find((s) => s.id === id);
        const src  = st.map.systems.find((s) => s.id === fix.sourceId);
        if (node && src) {
          const snap = st.snapToGrid ? roundToGrid : (n: number) => n;
          let { x, y } = node.position;
          let moved = false;
          if (fix.fixY && y + height > src.position.y - PLACEMENT_GAP) {
            y = snap(src.position.y - PLACEMENT_GAP - height);
            moved = true;
          }
          if (fix.fixX && x + width > src.position.x - PLACEMENT_GAP) {
            x = snap(src.position.x - PLACEMENT_GAP - width);
            moved = true;
          }
          if (moved) st.moveSystem(id, { x, y }, { skipUndo: true });
        }
      }
    },
    forgetNodeSize: (id) => {
      // NB: do NOT drop a pending placementFix here. forgetNodeSize fires on
      // every ResizeObserver-effect cleanup — including React StrictMode's
      // setup/cleanup/setup double-invoke in dev — which would wipe the fix
      // before the real measure consumes it. The fix is cleared in
      // reportNodeSize (on apply) or removeSystem (on real removal).
      if (!nodeSizes.delete(id)) return;
      const { w, h } = recomputeUniformMax();
      const cur = get();
      if (cur.uniformWidth !== w || cur.uniformHeight !== h) {
        set({ uniformWidth: w, uniformHeight: h });
      }
    },

    // Drop every cached natural size and reset the broadcast uniform
    // dimensions to 0. Every SystemNode unclamps for one render,
    // ResizeObserver fires with the natural sizes, the store rebuilds
    // the max, and the clamp reapplies — all within a couple of frames.
    // Invoked when font scaling changes the natural sizes underneath us.
    resetUniformSizes: () => {
      nodeSizes.clear();
      const cur = get();
      if (cur.uniformWidth !== 0 || cur.uniformHeight !== 0) {
        set({ uniformWidth: 0, uniformHeight: 0 });
      }
    },

    setEasyConnect: (v) => {
      set({ easyConnect: v });
      api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ easyConnect: v }) }).catch(console.error);
    },
    setMapOptionsOpen: (v) => set({ mapOptionsOpen: v }),
    setEdgeStyle: (v) => set({ edgeStyle: v }),
    requestAutoLayout: () => set({ autoLayoutPending: true }),
    clearAutoLayoutPending: () => set({ autoLayoutPending: false }),
    requestFitView: () => set({ fitViewPending: true }),
    clearFitView: () => set({ fitViewPending: false }),

    requestCenterOnEveSystem: (eveSystemId) => set({ centerRequestEveId: eveSystemId }),
    requestCenterOnNode: (nodeId) => set({ centerRequestNodeId: nodeId }),
    clearCenterRequest: () => set({ centerRequestEveId: null, centerRequestNodeId: null }),

    setRouteOrigin: (o) => set({ routeOrigin: o }),

    // ── Systems ───────────────────────────────────────────────────────────────

    addSystem: (name, systemClass, position, opts = {}) => {
      const { eveSystemId = null, effect = 'none', statics = [], regionName = null, npcType = null } = opts;
      const { activeMapId } = get();
      const id = uuid();

      set((s) => {
        // No duplicates on a map — enforced server-side too via a partial
        // unique index on (map_id, eve_system_id). Resolved-system nodes
        // dedupe by eve_system_id; placeholder nodes (no eve id) dedupe by
        // name so the user can't accidentally add "Unknown" twice either.
        const duplicate = s.map.systems.some((sys) =>
          eveSystemId !== null
            ? sys.eveSystemId === eveSystemId
            : sys.eveSystemId === null && sys.name.toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) return {};
        return {
          map: {
            ...s.map,
            updatedAt: new Date().toISOString(),
            systems: [
              ...s.map.systems,
              { id, eveSystemId, name, systemClass, effect, statics, regionName, npcType,
                position, status: 'unknown', isHome: s.map.systems.length === 0, locked: false, notes: '',
                lastActivityAt: new Date().toISOString() },
            ],
          },
        };
      });

      const added = get().map.systems.find((s) => s.id === id);
      if (added) {
        get().pushUndo({ type: 'add_system', systemId: id });
        if (activeMapId) {
          const url  = `/api/maps/${activeMapId}/systems`;
          const body = JSON.stringify({ ...added });
          api<{ system?: { security?: number | null; eveSystemId?: number | null } }>(url, { method: 'POST', body })
            .then((resp) => {
              // Backfill server-derived fields (SDE security, resolved eve id)
              // onto the optimistic node — addSystem can't know these, and the
              // live-sync echo is suppressed for the originating client, so
              // without this the node would lack sec status until a reload.
              const srv = resp?.system;
              if (!srv) return;
              set((s) => ({
                map: {
                  ...s.map,
                  systems: s.map.systems.map((sys) =>
                    sys.id === id
                      ? {
                          ...sys,
                          ...(srv.security != null ? { security: srv.security } : {}),
                          ...(srv.eveSystemId != null ? { eveSystemId: srv.eveSystemId } : {}),
                        }
                      : sys),
                },
              }));
            })
            .catch(() => enqueue(`addSystem:${added.name}`, url, 'POST', body));
        }
      }

      return id;
    },

    updateSystem: (id, updates, opts) => {
      const { activeMapId, map } = get();
      if (!opts?.skipUndo) {
        const sys = map.systems.find((s) => s.id === id);
        if (sys) {
          const prev: Partial<MapSystem> = {};
          for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
            (prev as Record<string, unknown>)[key] = sys[key as keyof MapSystem];
          }
          get().pushUndo({ type: 'update_system', systemId: id, prev });
        }
      }
      set((s) => ({
        map: {
          ...s.map,
          updatedAt: new Date().toISOString(),
          systems: s.map.systems.map((sys) => (sys.id === id ? { ...sys, ...updates } : sys)),
        },
      }));
      if (activeMapId) {
        const url  = `/api/maps/${activeMapId}/systems/${id}`;
        const body = JSON.stringify(updates);
        api(url, { method: 'PATCH', body }).catch(() =>
          enqueue(`updateSystem:${id}`, url, 'PATCH', body),
        );
      }
    },

    lockSystem: (id) => {
      const { map } = get();
      const sys = map.systems.find((s) => s.id === id);
      if (sys) get().pushUndo({ type: 'update_system', systemId: id, prev: { locked: sys.locked } });

      set((s) => ({
        map: {
          ...s.map,
          updatedAt: new Date().toISOString(),
          systems: s.map.systems.map((sys) =>
            sys.id === id ? { ...sys, locked: !sys.locked } : sys,
          ),
        },
      }));
      const { activeMapId, map: updated } = get();
      if (activeMapId) {
        const updatedSys = updated.systems.find((s) => s.id === id);
        if (updatedSys) {
          const url  = `/api/maps/${activeMapId}/systems/${id}`;
          const body = JSON.stringify({ locked: updatedSys.locked });
          api(url, { method: 'PATCH', body }).catch(() =>
            enqueue(`lockSystem:${id}`, url, 'PATCH', body),
          );
        }
      }
    },

    removeSystem: (id) => {
      placementFixes.delete(id);
      const { activeMapId, map } = get();
      const sys = map.systems.find((s) => s.id === id);
      const affectedConns = map.connections.filter((c) => c.sourceId === id || c.targetId === id);
      if (sys) get().pushUndo({ type: 'remove_system', system: sys, connections: affectedConns });

      set((s) => ({
        selectedSystemId: s.selectedSystemId === id ? null : s.selectedSystemId,
        map: {
          ...s.map,
          updatedAt: new Date().toISOString(),
          systems: s.map.systems.filter((sys) => sys.id !== id),
          connections: s.map.connections.filter((c) => c.sourceId !== id && c.targetId !== id),
        },
      }));
      if (activeMapId) {
        const url = `/api/maps/${activeMapId}/systems/${id}`;
        api(url, { method: 'DELETE' }).catch(() =>
          enqueue(`removeSystem:${id}`, url, 'DELETE', ''),
        );
      }
    },

    moveSystem: (id, position, opts) => {
      const { activeMapId, map } = get();
      if (!opts?.skipUndo) {
        const sys = map.systems.find((s) => s.id === id);
        if (sys) get().pushUndo({ type: 'move_system', systemId: id, prevPosition: sys.position });
      }

      set((s) => ({
        map: {
          ...s.map,
          systems: s.map.systems.map((sys) => (sys.id === id ? { ...sys, position } : sys)),
        },
      }));
      if (activeMapId) syncMove(activeMapId, id, position);
    },

    // ── Connections ───────────────────────────────────────────────────────────

    addConnection: (sourceId, targetId, sourceHandle = null, targetHandle = null) => {
      const { activeMapId } = get();
      const id = uuid();

      set((s) => {
        const already = s.map.connections.some(
          (c) =>
            (c.sourceId === sourceId && c.targetId === targetId) ||
            (c.sourceId === targetId && c.targetId === sourceId),
        );
        if (already) return {};
        return {
          map: {
            ...s.map,
            updatedAt: new Date().toISOString(),
            connections: [
              ...s.map.connections,
              { id, sourceId, targetId, sourceHandle, targetHandle,
                type: null, connectionType: 'standard',
                massStatus: null, timeStatus: null, size: 'large',
                massUsed: 0, eolAt: null,
                sourceSignatureId: null, targetSignatureId: null, broken: false,
                createdAt: new Date().toISOString() },
            ],
          },
        };
      });

      const conn = get().map.connections.find((c) => c.id === id);
      if (conn) {
        get().pushUndo({ type: 'add_connection', connectionId: id });
        if (activeMapId) {
          const url  = `/api/maps/${activeMapId}/connections`;
          const body = JSON.stringify({ ...conn });
          api<{ ok: boolean; connectionType?: string }>(url, { method: 'POST', body })
            .then((r) => {
              // Server may auto-classify an in-game gate (stargate-adjacent
              // systems). Reflect it locally so the chain/edge updates without
              // a reload.
              if (r?.connectionType && r.connectionType !== 'standard') {
                set((s) => ({
                  map: { ...s.map, connections: s.map.connections.map((c) =>
                    c.id === id ? { ...c, connectionType: r.connectionType as MapConnection['connectionType'] } : c) },
                }));
              }
            })
            .catch(() => enqueue(`addConnection:${id}`, url, 'POST', body));
        }
      }

      return id;
    },

    updateConnection: (id, updates) => {
      const { activeMapId, map } = get();
      const conn = map.connections.find((c) => c.id === id);
      if (conn) {
        const prev: Partial<MapConnection> = {};
        for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
          (prev as Record<string, unknown>)[key] = conn[key as keyof MapConnection];
        }
        get().pushUndo({ type: 'update_connection', connectionId: id, prev });
      }
      set((s) => ({
        map: {
          ...s.map,
          updatedAt: new Date().toISOString(),
          connections: s.map.connections.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        },
      }));
      if (activeMapId) {
        const url  = `/api/maps/${activeMapId}/connections/${id}`;
        const body = JSON.stringify(updates);
        api(url, { method: 'PATCH', body }).catch(() =>
          enqueue(`updateConnection:${id}`, url, 'PATCH', body),
        );
      }
    },

    optimizeConnections: () => {
      const { map } = get();
      const posById = new Map(map.systems.map((s) => [s.id, s.position] as const));
      for (const conn of map.connections) {
        const src = posById.get(conn.sourceId);
        const tgt = posById.get(conn.targetId);
        if (!src || !tgt) continue;
        const { sourceHandle, targetHandle } = pickHandles(src, tgt);
        if (conn.sourceHandle !== sourceHandle || conn.targetHandle !== targetHandle) {
          get().updateConnection(conn.id, { sourceHandle, targetHandle });
        }
      }
    },

    removeConnection: (id) => {
      const { activeMapId, map } = get();
      const conn = map.connections.find((c) => c.id === id);
      if (conn) get().pushUndo({ type: 'remove_connection', connection: conn });

      set((s) => ({
        selectedConnectionId: s.selectedConnectionId === id ? null : s.selectedConnectionId,
        map: {
          ...s.map,
          updatedAt: new Date().toISOString(),
          connections: s.map.connections.filter((c) => c.id !== id),
        },
      }));
      if (activeMapId) {
        const url = `/api/maps/${activeMapId}/connections/${id}`;
        api(url, { method: 'DELETE' }).catch(() =>
          enqueue(`removeConnection:${id}`, url, 'DELETE', ''),
        );
      }
    },

    addRoute: (name, systemIds, connectionIds) => {
      if (systemIds.length < 2) return null;
      const { activeMapId } = get();
      const id = uuid();
      const now = new Date().toISOString();
      const route: SavedRoute = { id, name, systemIds, connectionIds, createdAt: now, updatedAt: now };
      set((s) => ({ map: { ...s.map, routes: [...(s.map.routes ?? []), route] } }));
      if (activeMapId) {
        const url  = `/api/maps/${activeMapId}/routes`;
        const body = JSON.stringify({ id, name, systemIds, connectionIds });
        api(url, { method: 'POST', body }).catch(() => enqueue(`addRoute:${id}`, url, 'POST', body));
      }
      return id;
    },

    renameRoute: (id, name) => {
      const { activeMapId } = get();
      set((s) => ({
        map: { ...s.map, routes: (s.map.routes ?? []).map((r) => r.id === id ? { ...r, name } : r) },
      }));
      if (activeMapId) {
        const url  = `/api/maps/${activeMapId}/routes/${id}`;
        const body = JSON.stringify({ name });
        api(url, { method: 'PATCH', body }).catch(() => enqueue(`renameRoute:${id}`, url, 'PATCH', body));
      }
    },

    removeRoute: (id) => {
      const { activeMapId } = get();
      set((s) => ({ map: { ...s.map, routes: (s.map.routes ?? []).filter((r) => r.id !== id) } }));
      if (activeMapId) {
        const url = `/api/maps/${activeMapId}/routes/${id}`;
        api(url, { method: 'DELETE' }).catch(() => enqueue(`removeRoute:${id}`, url, 'DELETE', ''));
      }
    },

    selectSystem: (id) => set({ selectedSystemId: id, selectedConnectionId: null }),
    selectConnection: (id) => set({ selectedConnectionId: id, selectedSystemId: null }),
    setCurrentSystem: (id) => set({ currentSystemId: id }),

    applyRemote: (event) => {
      // Surgical state updates only — no API call, no undo entry. Each branch
      // dedupes / no-ops so a stray or out-of-order event can't corrupt state.
      switch (event.type) {
        case 'system.add': {
          const sys = event.system;
          set((s) => s.map.systems.some((x) => x.id === sys.id)
            ? s
            : { map: { ...s.map, systems: [...s.map.systems, sys] } });
          break;
        }
        case 'system.update': {
          set((s) => ({
            map: { ...s.map, systems: s.map.systems.map((x) => x.id === event.id ? { ...x, ...event.updates } : x) },
          }));
          break;
        }
        case 'system.remove': {
          set((s) => ({
            selectedSystemId: s.selectedSystemId === event.id ? null : s.selectedSystemId,
            map: {
              ...s.map,
              systems: s.map.systems.filter((x) => x.id !== event.id),
              connections: s.map.connections.filter((c) => c.sourceId !== event.id && c.targetId !== event.id),
            },
          }));
          break;
        }
        case 'connection.add': {
          const conn = event.connection;
          set((s) => s.map.connections.some((c) => c.id === conn.id)
            ? s
            : { map: { ...s.map, connections: [...s.map.connections, conn] } });
          break;
        }
        case 'connection.update': {
          set((s) => ({
            map: { ...s.map, connections: s.map.connections.map((c) => c.id === event.id ? { ...c, ...event.updates } : c) },
          }));
          break;
        }
        case 'connection.remove': {
          set((s) => ({
            selectedConnectionId: s.selectedConnectionId === event.id ? null : s.selectedConnectionId,
            map: { ...s.map, connections: s.map.connections.filter((c) => c.id !== event.id) },
          }));
          break;
        }
        case 'route.add': {
          const route = event.route;
          set((s) => (s.map.routes ?? []).some((r) => r.id === route.id)
            ? s
            : { map: { ...s.map, routes: [...(s.map.routes ?? []), route] } });
          break;
        }
        case 'route.update': {
          set((s) => ({
            map: { ...s.map, routes: (s.map.routes ?? []).map((r) => r.id === event.id ? { ...r, ...event.updates } : r) },
          }));
          break;
        }
        case 'route.remove': {
          set((s) => ({
            map: { ...s.map, routes: (s.map.routes ?? []).filter((r) => r.id !== event.id) },
          }));
          break;
        }
        case 'map.meta': {
          set((s) => ({
            map: {
              ...s.map,
              ...(event.name   !== undefined ? { name:   event.name }   : {}),
              ...(event.locked !== undefined ? { locked: event.locked } : {}),
            },
            maps: s.maps.map((m) => m.id === s.activeMapId
              ? { ...m,
                  ...(event.name   !== undefined ? { name:   event.name }   : {}),
                  ...(event.locked !== undefined ? { locked: event.locked } : {}) }
              : m),
          }));
          break;
        }
        case 'map.resync': {
          // Bulk change (merge) — re-fetch the active map authoritatively.
          const id = get().activeMapId;
          if (id) void get().switchMap(id);
          break;
        }
        case 'sig.changed': {
          set((s) => ({ sigRev: { ...s.sigRev, [event.systemId]: (s.sigRev[event.systemId] ?? 0) + 1 } }));
          break;
        }
        case 'structure.changed': {
          set((s) => ({ structRev: { ...s.structRev, [event.systemId]: (s.structRev[event.systemId] ?? 0) + 1 } }));
          break;
        }
        case 'anom.changed': {
          set((s) => ({ anomRev: { ...s.anomRev, [event.systemId]: (s.anomRev[event.systemId] ?? 0) + 1 } }));
          break;
        }
      }
    },
  };
});
