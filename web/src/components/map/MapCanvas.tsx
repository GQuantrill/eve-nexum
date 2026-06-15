import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow, Background, Controls, ControlButton, MiniMap,
  useNodesState, BackgroundVariant, useReactFlow, ConnectionMode,
  applyNodeChanges,
} from '@xyflow/react';
import type { Connection, Node, Edge, EdgeChange, NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { useAccountLocations } from '../../hooks/useAccountLocations';
import { useWatchlistAlerts } from '../../hooks/useWatchlistAlerts';
import { useMapSignatureIndex } from '../../hooks/useMapSignatureIndex';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useMinimapPosition } from '../../hooks/useMinimapPosition';
import { useShareMode } from '../../context/ShareModeContext';
import { SystemNode } from './SystemNode';
import { ConnectionEdge } from './ConnectionEdge';
import { AddSystemModal } from '../ui/AddSystemModal';
import { ContextMenu } from '../ui/ContextMenu';
import {
  PathIcon, MapPinSimpleIcon, HouseIcon, LockIcon, LockOpenIcon,
  XIcon, CheckIcon, PlusIcon, SelectionAllIcon, EyeIcon, CrosshairSimpleIcon,
  LinkSimpleIcon, ArrowsOutIcon,
} from '@phosphor-icons/react';
import type { MapSystem, SystemIntel } from '../../types';
import { CLASS_COLORS } from '../../data/wormholes';
import { cssVarToHex } from '../../utils/cssVar';
import { pickHandles } from './edgeUtils';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { toast } from '../ui/Toaster';
import { useCustomIntel } from '../../hooks/useCustomIntel';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useCurrentHourKills } from '../../hooks/useCurrentHourKills';
import { useFleet } from '../../hooks/useFleet';
import { HeatmapContext } from '../../context/HeatmapContext';
import { heatValue, type HeatMetric } from '../../utils/heatmap';
import { resolveIntelColor } from '../../utils/intelColors';

const NODE_TYPES = { system: SystemNode };

// Zoom bounds — shared by the <ReactFlow> props and the inverted-wheel handler.
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;

function resolveOverlaps(
  items: Array<{ id: string; x: number; y: number; w: number; h: number; locked: boolean }>,
  padding = 24,
) {
  const pos = items.map((n) => ({ ...n }));
  for (let iter = 0; iter < 500; iter++) {
    let anyMoved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j];
        if (a.locked && b.locked) continue;
        const olR = (a.x + a.w + padding) - b.x;
        const olL = (b.x + b.w + padding) - a.x;
        const olB = (a.y + a.h + padding) - b.y;
        const olT = (b.y + b.h + padding) - a.y;
        if (olR <= 0 || olL <= 0 || olB <= 0 || olT <= 0) continue;
        const min = Math.min(olR, olL, olB, olT);
        const canA = !a.locked, canB = !b.locked;
        const aS = canA ? (canB ? min / 2 : min) : 0;
        const bS = canB ? (canA ? min / 2 : min) : 0;
        if      (min === olR) { a.x -= aS; b.x += bS; }
        else if (min === olL) { a.x += aS; b.x -= bS; }
        else if (min === olB) { a.y -= aS; b.y += bS; }
        else                  { a.y += aS; b.y -= bS; }
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }
  return pos;
}
const EDGE_TYPES = { connection: ConnectionEdge };

interface CtxMenu {
  screenX: number;
  screenY: number;
  flowX:   number;
  flowY:   number;
  nodeId?: string;
  edgeId?: string;
  selectedNodeIds?: string[]; // snapshot taken at right-click time before RF resets selection
}

function systemToNode(sys: MapSystem, selectedId: string | null, easyConnect = false, canEdit = true): Node {
  return {
    id: sys.id,
    type: 'system',
    position: sys.position,
    data: { ...sys, selected: sys.id === selectedId },
    draggable: canEdit && !sys.locked,
    dragHandle: easyConnect ? '.drag-handle' : undefined,
  };
}

export function MapCanvas() {
  const { t } = useTranslation();
  useMapSignatureIndex();
  useWatchlistAlerts();
  const systems              = useMapStore((s) => s.map.systems);
  const connections          = useMapStore((s) => s.map.connections);
  const selectedSystemId     = useMapStore((s) => s.selectedSystemId);
  const selectedConnectionId = useMapStore((s) => s.selectedConnectionId);
  const snapToGrid           = useMapStore((s) => s.snapToGrid);
  const showMinimap          = useMapStore((s) => s.showMinimap);
  const [minimapPosition]    = useMinimapPosition();
  // React Flow's <Controls> usually sits bottom-left. When the user docks
  // the minimap into the same corner, push the zoom buttons to the
  // opposite bottom corner so they don't overlap.
  const controlsPosition     = minimapPosition === 'bottom-left' ? 'bottom-right' : 'bottom-left';
  // Sidebar opens from the right and overlaps anything anchored to the
  // right edge; only the right-side minimap variants need to dodge it.
  const minimapDodgesSidebar = minimapPosition === 'bottom-right' || minimapPosition === 'top-right';
  const easyConnect          = useMapStore((s) => s.easyConnect);
  const mapOptionsOpen       = useMapStore((s) => s.mapOptionsOpen);
  const edgeStyle            = useMapStore((s) => s.edgeStyle);
  const connectionThickness  = useMapStore((s) => s.connectionThickness);
  const addConnection        = useMapStore((s) => s.addConnection);
  const moveSystem           = useMapStore((s) => s.moveSystem);
  const lockSystem           = useMapStore((s) => s.lockSystem);
  const updateSystem         = useMapStore((s) => s.updateSystem);
  const removeSystem         = useMapStore((s) => s.removeSystem);
  const removeConnection     = useMapStore((s) => s.removeConnection);
  const updateConnection     = useMapStore((s) => s.updateConnection);
  const selectConnection     = useMapStore((s) => s.selectConnection);
  const undo                 = useMapStore((s) => s.undo);
  const autoLayoutPending    = useMapStore((s) => s.autoLayoutPending);
  const clearAutoLayoutPending = useMapStore((s) => s.clearAutoLayoutPending);
  const requestAutoLayout    = useMapStore((s) => s.requestAutoLayout);
  const optimizeConnections  = useMapStore((s) => s.optimizeConnections);
  const compactMode          = useMapStore((s) => s.compactMode);
  const uniformSize          = useMapStore((s) => s.uniformSize);
  const fitViewPending       = useMapStore((s) => s.fitViewPending);
  const clearFitView         = useMapStore((s) => s.clearFitView);
  const centerRequestEveId   = useMapStore((s) => s.centerRequestEveId);
  const centerRequestNodeId  = useMapStore((s) => s.centerRequestNodeId);
  const clearCenterRequest   = useMapStore((s) => s.clearCenterRequest);
  const currentSystemId      = useMapStore((s) => s.currentSystemId);
  const routeOrigin          = useMapStore((s) => s.routeOrigin);
  const setRouteOrigin       = useMapStore((s) => s.setRouteOrigin);
  const requestCenterOnEveSystem = useMapStore((s) => s.requestCenterOnEveSystem);
  const accountLocations     = useAccountLocations();
  const pushUndo             = useMapStore((s) => s.pushUndo);
  const canEdit              = useCanEdit();
  const { screenToFlowPosition, setViewport, getViewport, getNode, getNodes, getZoom, fitView } = useReactFlow();
  // Invert mouse-wheel / trackpad zoom (per-user, cross-device). Off by default.
  const [invertZoom] = useUserSetting<boolean>('nexum.map.invertZoom', false);
  // Subscribed so the canvas-painted MiniMap (which can't read CSS vars)
  // re-resolves class colours when the colour-vision mode changes.
  const [colorVision] = useUserSetting<string>('nexum.a11y.colorVision', 'off');

  // Active heatmap. The per-map max is computed once here and shared via
  // HeatmapContext so each node only divides its own value by it.
  const [heatMetric]    = useUserSetting<HeatMetric>('nexum.map.heatmap', 'none');
  const [heatIntensity] = useUserSetting<number>('nexum.map.heatIntensity', 1);
  const heatKills    = useCurrentHourKills();
  const heatFleet    = useFleet();
  const selfCharId   = useAuth().user?.characterId ?? null;
  const heatMax = useMemo(() => {
    if (heatMetric === 'none') return 0;
    let max = 0;
    for (const s of systems) {
      const v = heatValue(heatMetric, s.eveSystemId, heatKills, heatFleet, selfCharId);
      if (v > max) max = v;
    }
    return max;
  }, [heatMetric, systems, heatKills, heatFleet, selfCharId]);
  const heatmapState = useMemo(
    () => ({ metric: heatMetric, max: heatMax, intensity: heatIntensity, colorVision }),
    [heatMetric, heatMax, heatIntensity, colorVision],
  );

  const [pendingPosition, setPendingPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu]         = useState<CtxMenu | null>(null);
  const [customIntel] = useCustomIntel();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Inverted-zoom handler. When on, React Flow's own wheel AND pinch zoom are
  // off (zoomOnScroll / zoomOnPinch = !invertZoom) and we handle both here with
  // the direction flipped, anchored at the cursor, matching d3-zoom's scaling so
  // the feel is unchanged. Covers a mac trackpad pinch too — the browser
  // delivers that as a ctrl+wheel event, so it must NOT be skipped. Non-passive
  // listener so we can preventDefault the page scroll / browser pinch-zoom.
  useEffect(() => {
    if (!invertZoom) return;
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Match d3-zoom's wheelDelta (incl. its x10 for ctrl/pinch) so the speed
      // is identical to React Flow's native zoom; only the sign is flipped (no
      // negation here) so scroll-up / pinch-out zooms out instead of in.
      const delta  = e.deltaY
        * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002)
        * (e.ctrlKey ? 10 : 1);
      const factor = Math.pow(2, delta);
      const { x, y, zoom } = getViewport();
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      if (next === zoom) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Keep the flow point under the cursor fixed across the zoom.
      setViewport({
        x: px - ((px - x) / zoom) * next,
        y: py - ((py - y) / zoom) * next,
        zoom: next,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [invertZoom, getViewport, setViewport]);

  // React Flow's <Controls> buttons read their hover title + aria-label from
  // ariaLabelConfig (merged with the library defaults), so this translates the
  // zoom / fit / lock tooltips without re-implementing the buttons.
  const ariaLabelConfig = useMemo(() => ({
    'controls.ariaLabel':            t('mapControls.panel'),
    'controls.zoomIn.ariaLabel':     t('mapControls.zoomIn'),
    'controls.zoomOut.ariaLabel':    t('mapControls.zoomOut'),
    'controls.fitView.ariaLabel':    t('mapControls.fitView'),
    'controls.interactive.ariaLabel': t('mapControls.interactive'),
  }), [t]);

  // Empty initial — the `systems` effect below replaces this on the next
  // frame with the real node set. Starting empty avoids the dead useMemo that
  // only ever ran once before being overwritten.
  const [nodes, setNodes] = useNodesState<Node>([]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      changes.forEach((c) => {
        if (c.type === 'remove') {
          if (!canEdit) return;
          const sys = systems.find((s) => s.id === c.id);
          if (!sys?.locked) removeSystem(c.id);
        }
      });
      setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
    },
    [systems, removeSystem, setNodes, canEdit],
  );

  const centerOnSystem = useCallback((systemId: string, zoomOverride?: number) => {
    const node = getNode(systemId);
    if (!node) return false;

    const zoom   = zoomOverride ?? getZoom();
    const flowX  = node.position.x + (node.measured?.width  ?? 150) / 2;
    const flowY  = node.position.y + (node.measured?.height ?? 80)  / 2;

    const rfEl   = document.querySelector<HTMLElement>('.react-flow');
    const panel  = document.querySelector<HTMLElement>('.system-panel');
    const cW     = rfEl?.offsetWidth  ?? window.innerWidth;
    const cH     = rfEl?.offsetHeight ?? window.innerHeight;
    const panelH = panel?.offsetHeight ?? 0;

    setViewport(
      {
        x:    cW / 2 - flowX * zoom,
        y:    (cH - panelH) / 2 - flowY * zoom,
        zoom,
      },
      { duration: 300 },
    );
    return true;
  }, [getNode, getZoom, setViewport]);

  // "Centre on me" map-control: recentre on the pilot's current system node
  // (the you-are-here node). Disabled when the pilot isn't in a mapped system.
  const centerOnMe = useCallback(() => {
    if (currentSystemId) centerOnSystem(currentSystemId);
  }, [currentSystemId, centerOnSystem]);

  // On first load after login, centre the viewport on the pilot's last known
  // system (from /auth/me) if it's present on this map — so you land where you
  // last were, even when offline. Runs once; falls back to the normal fitView
  // when the system isn't on the map.
  const lastKnownSystemId = useAuth().user?.lastKnownSystem?.id ?? null;
  const didInitialCentre = useRef(false);
  useEffect(() => {
    if (didInitialCentre.current || lastKnownSystemId == null || nodes.length === 0) return;
    const target = systems.find((s) => s.eveSystemId === lastKnownSystemId);
    if (!target) { didInitialCentre.current = true; return; } // not on this map
    clearFitView(); // don't let the fit-whole-map effect fight the centre
    const raf = requestAnimationFrame(() => {
      if (centerOnSystem(target.id)) didInitialCentre.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [lastKnownSystemId, nodes, systems, centerOnSystem, clearFitView]);

  // Centre + zoom on an explicitly requested system (e.g. clicking the pilot's
  // location in the toolbar). Zooms in if currently zoomed out; no-op when the
  // system isn't on this map. Clears the request either way.
  useEffect(() => {
    if (centerRequestEveId == null) return;
    const target = systems.find((s) => s.eveSystemId === centerRequestEveId);
    const zoom = Math.max(getZoom(), 1.1);
    const raf = requestAnimationFrame(() => {
      if (target) centerOnSystem(target.id, zoom);
      clearCenterRequest();
    });
    return () => cancelAnimationFrame(raf);
  }, [centerRequestEveId, systems, centerOnSystem, getZoom, clearCenterRequest]);

  // Centre + zoom on an explicitly requested map node (e.g. the watchlist
  // "show on map" button). Keyed by node id so it works for custom systems too.
  useEffect(() => {
    if (centerRequestNodeId == null) return;
    const zoom = Math.max(getZoom(), 1.1);
    const raf = requestAnimationFrame(() => {
      centerOnSystem(centerRequestNodeId, zoom);
      clearCenterRequest();
    });
    return () => cancelAnimationFrame(raf);
  }, [centerRequestNodeId, centerOnSystem, getZoom, clearCenterRequest]);

  // Follow a tracked character: when routing/centring is pinned to another of
  // the account's characters and they jump, update the origin to their new
  // system and re-centre on them. Driven by the account-locations poll.
  useEffect(() => {
    if (!routeOrigin) return;
    const cur = accountLocations.byChar.get(routeOrigin.charId);
    if (cur && cur.eveSystemId !== routeOrigin.eveSystemId) {
      setRouteOrigin({
        charId:        routeOrigin.charId,
        characterName: routeOrigin.characterName,
        eveSystemId:   cur.eveSystemId,
        systemName:    cur.systemName ?? '',
        systemClass:   cur.systemClass,
      });
      requestCenterOnEveSystem(cur.eveSystemId);
    }
  }, [accountLocations, routeOrigin, setRouteOrigin, requestCenterOnEveSystem]);

  // Preserve rubber-band selection when Shift is released before the mouse button.
  // React Flow clears the selection on Shift keyup, so we capture it just before.
  const shiftHeld        = useRef(false);
  const pendingSelection = useRef<string[]>([]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { shiftHeld.current = true; return; }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        undo().catch(console.error);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        if (!canEdit) return;

        // Multi-select: remove all RF-selected non-locked nodes
        const rfSelected = nodes.filter((n) => n.selected);
        if (rfSelected.length > 0) {
          rfSelected.forEach((n) => {
            const sys = systems.find((s) => s.id === n.id);
            if (!sys?.locked) removeSystem(n.id);
          });
          return;
        }

        // Single-click selected (panel open)
        if (selectedSystemId) {
          const sys = systems.find((s) => s.id === selectedSystemId);
          if (sys && !sys.locked) removeSystem(selectedSystemId);
        }
      }

      if (e.key === 'h' || e.key === 'H') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        const home = systems.find((s) => s.isHome);
        if (home) {
          centerOnSystem(home.id);
        } else {
          toast.info(t('ctxMenu.noHomeSet'));
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      shiftHeld.current = false;
      const ids = pendingSelection.current;
      pendingSelection.current = [];
      if (ids.length > 0) {
        // Defer until after React Flow's own keyup handler has cleared the selection
        setTimeout(() => setNodes((ns) => ns.map((n) => ({ ...n, selected: ids.includes(n.id) }))), 0);
      }
    };
    const onBlur = () => { shiftHeld.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    window.addEventListener('blur',    onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      window.removeEventListener('blur',    onBlur);
    };
  }, [nodes, selectedSystemId, systems, removeSystem, undo, setNodes, canEdit, centerOnSystem]);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    if (shiftHeld.current && sel.length > 0) pendingSelection.current = sel.map((n) => n.id);
  }, []);

  useEffect(() => {
    setNodes(systems.map((s) => systemToNode(s, selectedSystemId, easyConnect, canEdit)));
  }, [systems, selectedSystemId, easyConnect, setNodes, canEdit]);

  useEffect(() => {
    if (!selectedSystemId) return;
    // For newly-added nodes React Flow needs one frame to commit the node
    // before getNode can find it.
    if (!centerOnSystem(selectedSystemId)) {
      const raf = requestAnimationFrame(() => centerOnSystem(selectedSystemId));
      return () => cancelAnimationFrame(raf);
    }
  }, [selectedSystemId, centerOnSystem]);

  // Turning compact mode OFF grows every node, which can leave them overlapping.
  // Auto-run the same spread the sidebar button triggers — but only after a
  // beat, so React Flow has re-measured the now-larger nodes (otherwise overlap
  // detection runs on the stale, smaller compact sizes). Edit-only, since spread
  // moves and persists node positions. Fires only on the on→off transition.
  const prevCompact = useRef(compactMode);
  useEffect(() => {
    const was = prevCompact.current;
    prevCompact.current = compactMode;
    if (was && !compactMode && canEdit) {
      const t = setTimeout(() => requestAutoLayout(), 200);
      return () => clearTimeout(t);
    }
  }, [compactMode, canEdit, requestAutoLayout]);

  // A system added while the tab is backgrounded never gets measured (the
  // ResizeObserver is deferred for hidden tabs), so the uniform-size max can't
  // see it. When the tab regains focus everything re-measures and that max can
  // ratchet up — growing every node past the slots they were tiled into and
  // leaving them overlapping. Re-run the (overlap-only, undoable) spread once
  // the re-measure has settled, same as the compact-mode-off handler. No-op
  // when nothing actually overlaps; only matters with uniform size on.
  useEffect(() => {
    if (!uniformSize || !canEdit) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Generous delay so re-measurement (and any SSE-reconnect map refetch)
      // has finished before overlap detection runs.
      clearTimeout(timer);
      timer = setTimeout(() => requestAutoLayout(), 700);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [uniformSize, canEdit, requestAutoLayout]);

  useEffect(() => {
    if (!autoLayoutPending) return;
    clearAutoLayoutPending();

    const rfNodes = getNodes();
    if (rfNodes.length < 2) return;

    const items = rfNodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      // Fallbacks matter: react-flow's measured.{width,height} is set by a
      // ResizeObserver after the node renders. If we hit spread before a
      // node has been measured (or while a re-render has cleared the
      // measurement), the fallback drives overlap detection. A typical
      // SystemNode renders ~170×180 once it has sov logo + statics + sigs,
      // so we err on the generous side — better to space nodes a bit too
      // far apart than to compute a phantom 100px tall box that crashes
      // into a real 180px neighbour.
      w: n.measured?.width  ?? 200,
      h: n.measured?.height ?? 200,
      locked: systems.find((s) => s.id === n.id)?.locked ?? false,
    }));

    // Snap the spread output to the same 20px grid the canvas uses for
    // snapToGrid. Spread is a "tidy this up" action; aligning to the grid
    // after de-overlapping keeps the layout uniform regardless of where
    // the user happened to drop nodes before.
    const SNAP = 20;
    const snap = (v: number) => Math.round(v / SNAP) * SNAP;
    const resolved = resolveOverlaps(items).map((r) => ({
      ...r,
      x: snap(r.x),
      y: snap(r.y),
    }));

    const toMove = resolved.filter((r, i) =>
      Math.abs(r.x - items[i].x) > 0.5 || Math.abs(r.y - items[i].y) > 0.5,
    );
    if (toMove.length === 0) return;

    pushUndo({
      type: 'batch',
      commands: toMove.map((r) => {
        const orig = items.find((it) => it.id === r.id)!;
        return { type: 'move_system' as const, systemId: r.id, prevPosition: { x: orig.x, y: orig.y } };
      }),
    });

    toMove.forEach((r) => moveSystem(r.id, { x: r.x, y: r.y }, { skipUndo: true }));
  }, [autoLayoutPending, clearAutoLayoutPending, getNodes, systems, moveSystem, pushUndo]);

  // Fit/centre the whole map in view on request (region seed, or selecting a
  // map from the list). Defer over two frames so React Flow has committed the
  // incoming map's nodes — on a plain map switch the flag flips before the new
  // nodes mount, so fitting immediately would read a stale/empty node set.
  useEffect(() => {
    if (!fitViewPending) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (getNodes().length > 0) fitView({ padding: 0.08, duration: 400 });
        // Clear only after fitting — clearing up front flips the flag, re-runs
        // this effect, and its cleanup would cancel the rAF before it fires.
        clearFitView();
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [fitViewPending, clearFitView, fitView, getNodes]);

  // Sweep expired EOL connections every minute. A connection is considered
  // expired 4 h + 30 min grace after the user marked it EOL. The 30 min grace
  // gives the "expired" state a chance to be visible before removal.
  useEffect(() => {
    const EXPIRY_MS = (4 * 60 + 30) * 60 * 1000;
    const sweep = () => {
      const now = Date.now();
      for (const c of useMapStore.getState().map.connections) {
        if (!c.eolAt) continue;
        if (now - new Date(c.eolAt).getTime() >= EXPIRY_MS) {
          removeConnection(c.id);
        }
      }
    };
    sweep();
    const id = setInterval(sweep, 60_000);
    return () => clearInterval(id);
  }, [removeConnection]);

  // Live handle re-anchoring while a node is being dragged. The committed
  // sourceHandle/targetHandle only change on drag-stop; these local overrides
  // let the edge visually snap to the optimal handle pair *during* the drag
  // without writing to the store/server on every frame. Keyed by connection
  // id; merged into the edges memo (below) and cleared on drag-stop. Declared
  // here, before the edges memo that reads it, to avoid a TDZ error.
  const [dragHandles, setDragHandles] = useState<
    Map<string, { sourceHandle: string; targetHandle: string }>
  >(new Map());

  // Edges driven directly from store — no local duplicate state, except for
  // the live drag-handle overrides above.
  const edges = useMemo(
    () =>
      connections.map((c) => {
        const ov = dragHandles.get(c.id);
        return {
          id: c.id,
          source: c.sourceId,
          target: c.targetId,
          sourceHandle: ov?.sourceHandle ?? c.sourceHandle ?? undefined,
          targetHandle: ov?.targetHandle ?? c.targetHandle ?? undefined,
          type: 'connection',
          data: { ...c, edgeStyle, connectionThickness } as unknown as Record<string, unknown>,
          selected: c.id === selectedConnectionId,
        };
      }),
    [connections, selectedConnectionId, edgeStyle, connectionThickness, dragHandles],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      changes.forEach((change) => {
        if (change.type === 'remove' && canEdit) removeConnection(change.id);
      });
    },
    [removeConnection, canEdit],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!canEdit) return;
      if (!params.source || !params.target) return;
      // Always route the edge through the optimal handle pair based on the
      // two nodes' current positions, regardless of which handles the user
      // dragged from. Falls back to whatever ReactFlow handed us if either
      // node is missing from the store (shouldn't happen).
      const src = systems.find((s) => s.id === params.source);
      const tgt = systems.find((s) => s.id === params.target);
      if (src && tgt) {
        const { sourceHandle, targetHandle } = pickHandles(src.position, tgt.position);
        addConnection(params.source, params.target, sourceHandle, targetHandle);
        return;
      }
      const EASY = new Set(['easy-source', 'easy-target']);
      const srcH = params.sourceHandle && !EASY.has(params.sourceHandle) ? params.sourceHandle : null;
      const tgtH = params.targetHandle && !EASY.has(params.targetHandle) ? params.targetHandle : null;
      addConnection(params.source, params.target, srcH, tgtH);
    },
    [addConnection, canEdit, systems],
  );

  const onNodeDrag = useCallback(
    (_: React.MouseEvent, _node: Node, movedNodes: Node[]) => {
      if (!canEdit) return;
      const movedIds = new Set(movedNodes.map((n) => n.id));
      // Live positions: store positions overridden by the in-flight drag.
      const posMap = new Map(systems.map((s) => [s.id, s.position]));
      movedNodes.forEach((n) => posMap.set(n.id, n.position));

      setDragHandles((prev) => {
        let next = prev;
        for (const conn of connections) {
          if (!movedIds.has(conn.sourceId) && !movedIds.has(conn.targetId)) continue;
          const src = posMap.get(conn.sourceId);
          const tgt = posMap.get(conn.targetId);
          if (!src || !tgt) continue;
          const { sourceHandle, targetHandle } = pickHandles(src, tgt);
          const cur = next.get(conn.id);
          if (!cur || cur.sourceHandle !== sourceHandle || cur.targetHandle !== targetHandle) {
            if (next === prev) next = new Map(prev);
            next.set(conn.id, { sourceHandle, targetHandle });
          }
        }
        // Returning the same reference when nothing flipped avoids a re-render,
        // so this only costs a render when a handle actually changes side.
        return next;
      });
    },
    [canEdit, systems, connections],
  );

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, _node: Node, movedNodes: Node[]) => {
      if (!canEdit) return;
      movedNodes.forEach((n) => moveSystem(n.id, n.position));

      const movedIds = new Set(movedNodes.map((n) => n.id));
      // Build position map from store, then override with the just-dragged positions
      // (store hasn't updated yet when this fires)
      const posMap = new Map(systems.map((s) => [s.id, s.position]));
      movedNodes.forEach((n) => posMap.set(n.id, n.position));

      for (const conn of connections) {
        if (!movedIds.has(conn.sourceId) && !movedIds.has(conn.targetId)) continue;
        const src = posMap.get(conn.sourceId);
        const tgt = posMap.get(conn.targetId);
        if (!src || !tgt) continue;
        const { sourceHandle, targetHandle } = pickHandles(src, tgt);
        if (conn.sourceHandle !== sourceHandle || conn.targetHandle !== targetHandle) {
          updateConnection(conn.id, { sourceHandle, targetHandle });
        }
      }
      // The committed handles now match what the live override was showing, so
      // drop the overrides (no flicker — the store write above is synchronous).
      setDragHandles((prev) => (prev.size ? new Map() : prev));
    },
    [moveSystem, systems, connections, updateConnection, canEdit],
  );

  const nodeCtxFired = useRef(false);

  const { isShareMode } = useShareMode();

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      // Share-mode guests have nothing to do via the context menu — every
      // item in there is an edit action. Let the browser's native menu
      // through instead of intercepting.
      if (isShareMode) return;
      e.preventDefault();
      e.stopPropagation();
      nodeCtxFired.current = true;
      setTimeout(() => { nodeCtxFired.current = false; }, 0);
      const selectedNodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, nodeId: node.id, selectedNodeIds });
    },
    [nodes, isShareMode],
  );

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (isShareMode) return;
      if (nodeCtxFired.current) return;
      e.preventDefault();
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: flow.x, flowY: flow.y });
    },
    [screenToFlowPosition, isShareMode],
  );

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, selectedNodes: Node[]) => {
      if (isShareMode) return;
      e.preventDefault();
      e.stopPropagation();
      nodeCtxFired.current = true;
      setTimeout(() => { nodeCtxFired.current = false; }, 0);
      const selectedNodeIds = selectedNodes.map((n) => n.id);
      // Use the first node as the "primary" so single-node items still work
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, nodeId: selectedNodeIds[0], selectedNodeIds });
    },
    [isShareMode],
  );

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      // Share viewers have nothing to do here — every connection action
      // (set type, set mass/time status, delete) is an edit. Skip the
      // intercept so the browser's native menu fires instead.
      if (isShareMode) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, edgeId: edge.id });
    },
    [isShareMode],
  );

  // Click on the SVG edge path itself (the curve) selects the connection so
  // the bottom ConnectionPanel opens — same effect as clicking the label chip.
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      selectConnection(edge.id);
    },
    [selectConnection],
  );

  const onPaneClick = useCallback(() => setContextMenu(null), []);

  const ctxItems = (() => {
    if (!contextMenu) return [];

    // Without topology permission, hide every menu item that would mutate
    // systems or connections. Edges have no read-safe actions, so the menu
    // collapses entirely; nodes keep only the EVE waypoint actions.
    if (!canEdit) {
      if (contextMenu.edgeId) return [];
      if (contextMenu.nodeId) {
        const sys = systems.find((s) => s.id === contextMenu.nodeId);
        if (!sys?.eveSystemId) return [];
        return [
          {
            label: t('waypoint.setDestination'),
            icon: <MapPinSimpleIcon size={16} weight="regular" color="#3ddc84" />,
            action: () => { setDestination(sys.eveSystemId!, sys.name).catch(() => {}); },
          },
          {
            label: t('waypoint.addWaypoint'),
            icon: <PathIcon size={16} weight="regular" color="#5a9af8" />,
            action: () => { addWaypoint(sys.eveSystemId!, sys.name).catch(() => {}); },
          },
        ];
      }
      // Pane menu — only "Select All" survives.
      return [
        {
          label: t('ctxMenu.selectAll'),
          icon: <SelectionAllIcon size={16} weight="regular" />,
          action: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
          disabled: nodes.length === 0,
        },
      ];
    }

    if (contextMenu.edgeId) {
      const conn = connections.find((c) => c.id === contextMenu.edgeId);
      const isJumpgate  = conn?.connectionType === 'jumpgate';
      const timeStatus  = conn?.timeStatus  ?? 'fresh';
      const massStatus  = conn?.massStatus  ?? 'stable';
      const eid = contextMenu.edgeId;
      return [
        {
          label: t('ctxMenu.disconnect'),
          icon: <XIcon size={16} weight="regular" color="#e25a5a" />,
          action: () => removeConnection(eid),
        },
        { separator: true as const },
        {
          label: t('ctxMenu.jumpType'),
          submenu: [
            {
              label: t('ctxMenu.standardJump'),
              checked: !isJumpgate,
              action: () => updateConnection(eid, { connectionType: 'standard' }),
            },
            {
              label: t('ctxMenu.jumpgate'),
              checked: isJumpgate,
              action: () => updateConnection(eid, { connectionType: 'jumpgate' }),
            },
          ],
        },
        {
          label: t('ctxMenu.whLifetime'),
          submenu: (() => {
            // The submenu's checked indicator reflects what the user last
            // selected (categorical), not the live derived stage. Live stage
            // lives on the edge label; this is just "what option did I click?".
            const hasEol = !!conn?.eolAt;
            const stage: 'fresh' | 'lessThan24h' | 'eol' =
              timeStatus === 'lessThan24h' ? 'lessThan24h' :
              hasEol || timeStatus === 'eol' ? 'eol' :
              'fresh';
            const eolFromOffset = (hrsBack: number) =>
              new Date(Date.now() - hrsBack * 3_600_000).toISOString();
            return [
              {
                label: t('ctxMenu.lifeFresh'),
                checked: stage === 'fresh',
                action: () => updateConnection(eid, { timeStatus: 'fresh', eolAt: null }),
              },
              {
                label: t('ctxMenu.life1d'),
                checked: stage === 'lessThan24h',
                action: () => updateConnection(eid, { timeStatus: 'lessThan24h', eolAt: null }),
              },
              {
                label: t('ctxMenu.life4h'),
                checked: stage === 'eol',
                action: () => updateConnection(eid, { timeStatus: 'eol', eolAt: eolFromOffset(0) }),
              },
              {
                label: t('ctxMenu.life1h'),
                action: () => updateConnection(eid, { timeStatus: 'eol', eolAt: eolFromOffset(3) }),
              },
              {
                label: t('ctxMenu.lifeExpired'),
                action: () => updateConnection(eid, { timeStatus: 'eol', eolAt: eolFromOffset(4) }),
              },
            ];
          })(),
        },
        {
          label: t('ctxMenu.massStability'),
          submenu: [
            {
              label: t('ctxMenu.massStable'),
              checked: massStatus === 'stable',
              action: () => updateConnection(eid, { massStatus: 'stable' }),
            },
            {
              label: t('ctxMenu.massDestab'),
              checked: massStatus === 'destabilized',
              action: () => updateConnection(eid, { massStatus: 'destabilized' }),
            },
            {
              label: t('ctxMenu.massCrit'),
              checked: massStatus === 'critical',
              action: () => updateConnection(eid, { massStatus: 'critical' }),
            },
          ],
        },
      ];
    }

    if (contextMenu.nodeId) {
      const sys = systems.find((s) => s.id === contextMenu.nodeId);
      const selectedNodeIds = contextMenu.selectedNodeIds ?? [contextMenu.nodeId];
      const selectedNodes   = nodes.filter((n) => selectedNodeIds.includes(n.id));
      const multiSelected   = selectedNodes.length > 1;

      const waypointItems = !multiSelected && sys?.eveSystemId ? [
        { separator: true as const },
        {
          label: t('waypoint.setDestination'),
          icon: <MapPinSimpleIcon size={16} weight="regular" color="#3ddc84" />,
          action: () => { setDestination(sys.eveSystemId!, sys.name).catch(() => {}); },
        },
        {
          label: t('waypoint.addWaypoint'),
          icon: <PathIcon size={16} weight="regular" color="#5a9af8" />,
          action: () => { addWaypoint(sys.eveSystemId!, sys.name).catch(() => {}); },
        },
      ] : [];

      const multiItems = multiSelected ? [
        { separator: true as const },
        {
          label: t("ctxMenu.lockSelected", { count: selectedNodes.length }),
          icon: <LockIcon size={16} weight="regular" color="#f5c518" />,
          action: () => selectedNodes.forEach((n) => updateSystem(n.id, { locked: true })),
        },
        {
          label: t("ctxMenu.unlockSelected", { count: selectedNodes.length }),
          icon: <LockOpenIcon size={16} weight="regular" color="#f5c518" />,
          action: () => selectedNodes.forEach((n) => updateSystem(n.id, { locked: false })),
        },
        {
          label: t("ctxMenu.markCleared", { count: selectedNodes.length }),
          icon: <CheckIcon size={16} weight="regular" />,
          action: () => selectedNodes.forEach((n) => updateSystem(n.id, { status: 'cleared' })),
        },
      ] : [];

      // "Set as home" / "Unset home" — single selection only; isHome is a
      // mutually-exclusive flag, so setting one clears whichever was home before.
      const homeItem = !multiSelected ? [
        sys?.isHome
          ? {
              label: t('ctxMenu.unsetHome'),
              icon:  <HouseIcon size={16} weight="regular" color="#f0a040" />,
              action: () => updateSystem(contextMenu.nodeId!, { isHome: false }),
            }
          : {
              label: t('ctxMenu.setHome'),
              icon:  <HouseIcon size={16} weight="regular" color="#f0a040" />,
              action: () => {
                // Clear any previously-set home so only one exists at a time.
                const oldHome = systems.find((s) => s.isHome);
                if (oldHome && oldHome.id !== contextMenu.nodeId)
                  updateSystem(oldHome.id, { isHome: false });
                updateSystem(contextMenu.nodeId!, { isHome: true });
              },
            },
      ] : [];

      // Manual intel tag. Built-in options + the user's custom intels, each
      // rendered with a colored swatch via an inline span. Submenu shows a
      // check mark next to the currently-applied tag so the user can
      // recognise their choice at a glance.
      const BUILTIN_INTEL: Array<{ value: SystemIntel; label: string }> = [
        { value: 'friendly', label: t('ctxMenu.intelFriendly') },
        { value: 'hostile',  label: t('ctxMenu.intelHostile') },
        { value: 'occupied', label: t('ctxMenu.intelOccupied') },
        { value: 'empty',    label: t('ctxMenu.intelEmpty') },
      ];
      const intelSwatch = (value: SystemIntel) => {
        const c = resolveIntelColor(value, customIntel);
        if (!c) return undefined;
        return <span className="intel-swatch" style={{ background: c }} aria-hidden="true" />;
      };
      const customEntries = customIntel.map((ci) => ({ value: ci.id, label: ci.label || t('ctxMenu.intelUnnamed') }));
      const intelItem = !multiSelected ? [
        {
          label: t('ctxMenu.setIntel'),
          icon:  <EyeIcon size={16} weight="regular" color="#6ea0ff" />,
          submenu: [
            ...BUILTIN_INTEL.map((o) => ({
              label:   o.label,
              icon:    intelSwatch(o.value),
              checked: sys?.intel === o.value,
              action:  () => updateSystem(contextMenu.nodeId!, { intel: o.value }),
            })),
            ...(customEntries.length > 0 ? [{ separator: true as const }] : []),
            ...customEntries.map((o) => ({
              label:   o.label,
              icon:    intelSwatch(o.value),
              checked: sys?.intel === o.value,
              action:  () => updateSystem(contextMenu.nodeId!, { intel: o.value }),
            })),
            { separator: true as const },
            {
              label:   t('ctxMenu.clearIntel'),
              checked: !sys?.intel,
              action:  () => updateSystem(contextMenu.nodeId!, { intel: null }),
            },
          ],
        },
      ] : [
        {
          label: t("ctxMenu.setIntelFor", { count: selectedNodes.length }),
          icon:  <EyeIcon size={16} weight="regular" color="#6ea0ff" />,
          submenu: [
            ...BUILTIN_INTEL.map((o) => ({
              label:  o.label,
              icon:   intelSwatch(o.value),
              action: () => selectedNodes.forEach((n) => updateSystem(n.id, { intel: o.value })),
            })),
            ...(customEntries.length > 0 ? [{ separator: true as const }] : []),
            ...customEntries.map((o) => ({
              label:  o.label,
              icon:   intelSwatch(o.value),
              action: () => selectedNodes.forEach((n) => updateSystem(n.id, { intel: o.value })),
            })),
            { separator: true as const },
            {
              label:  t('ctxMenu.clearIntel'),
              action: () => selectedNodes.forEach((n) => updateSystem(n.id, { intel: null })),
            },
          ],
        },
      ];

      return [
        {
          label: sys?.locked ? t('ctxMenu.unlockSystem') : t('ctxMenu.lockSystem'),
          icon:  sys?.locked
            ? <LockOpenIcon size={16} weight="regular" color="#f5c518" />
            : <LockIcon     size={16} weight="regular" color="#f5c518" />,
          action: () => lockSystem(contextMenu.nodeId!),
        },
        ...(!sys?.locked ? [{
          label: multiSelected ? t('ctxMenu.removeSystems', { count: selectedNodes.filter((n) => !systems.find((s) => s.id === n.id)?.locked).length }) : t('ctxMenu.removeSystem'),
          icon: <XIcon size={16} weight="regular" color="#e25a5a" />,
          action: () => {
            if (multiSelected) {
              selectedNodes
                .filter((n) => !systems.find((s) => s.id === n.id)?.locked)
                .forEach((n) => removeSystem(n.id));
            } else {
              removeSystem(contextMenu.nodeId!);
            }
          },
        }] : []),
        ...homeItem,
        ...intelItem,
        ...multiItems,
        ...waypointItems,
      ];
    }

    return [
      {
        label: t('ctxMenu.addSystem'),
        icon: <PlusIcon size={16} weight="regular" />,
        action: () => setPendingPosition({ x: contextMenu.flowX - 75, y: contextMenu.flowY - 40 }),
      },
      {
        label: t('ctxMenu.selectAll'),
        icon: <SelectionAllIcon size={14} weight="regular" />,
        action: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
        disabled: nodes.length === 0,
      },
      {
        label: t('ctxMenu.optimizeConnections'),
        icon: <LinkSimpleIcon size={15} weight="regular" />,
        action: () => optimizeConnections(),
        disabled: connections.length === 0,
      },
      {
        label: t('ctxMenu.spreadNodes'),
        icon: <ArrowsOutIcon size={15} weight="regular" />,
        action: () => requestAutoLayout(),
        disabled: nodes.length === 0,
      },
    ];
  })();

  return (
    <HeatmapContext.Provider value={heatmapState}>
    <div className="map-canvas" ref={wrapperRef}>
      <ReactFlow
        ariaLabelConfig={ariaLabelConfig}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onEdgeClick={onEdgeClick}
        proOptions={{ hideAttribution: true }}
        onSelectionContextMenu={onSelectionContextMenu}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={canEdit}
        nodesDraggable={canEdit}
        multiSelectionKeyCode="Shift"
        selectionKeyCode="Shift"
        snapToGrid={snapToGrid}
        snapGrid={[20, 20]}
        fitView
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomOnScroll={!invertZoom}
        zoomOnPinch={!invertZoom}
        deleteKeyCode={null}
      >
        <Background
          variant={snapToGrid ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={snapToGrid ? 20 : 24}
          size={snapToGrid ? 1 : 1}
          color={snapToGrid ? '#1a2240' : '#1a2040'}
        />
        <Controls position={controlsPosition}>
          <ControlButton
            onClick={centerOnMe}
            disabled={!currentSystemId}
            title={t('mapControls.centerOnMe')}
            aria-label={t('mapControls.centerOnMe')}
          >
            <CrosshairSimpleIcon size={14} weight="bold" />
          </ControlButton>
        </Controls>
        {showMinimap && (
          <MiniMap
            key={colorVision}
            pannable
            zoomable
            position={minimapPosition}
            nodeColor={(n) => {
              const sys = systems.find((s) => s.id === n.id);
              return sys ? cssVarToHex(CLASS_COLORS[sys.systemClass]) : '#333';
            }}
            maskColor="rgba(13,17,23,0.85)"
            onClick={(_e, position) => {
              const zoom = getZoom();
              const rfEl = document.querySelector<HTMLElement>('.react-flow');
              const cW = rfEl?.offsetWidth  ?? window.innerWidth;
              const cH = rfEl?.offsetHeight ?? window.innerHeight;
              setViewport(
                { x: cW / 2 - position.x * zoom, y: cH / 2 - position.y * zoom, zoom },
                { duration: 300 },
              );
            }}
            style={{
              background: '#0d1117',
              border: '3px solid #1e2740',
              borderRadius: '8px',
              // The sidebar opens from the right and overlaps anything in
              // the right two corners; left-anchored minimaps don't need
              // the dodge.
              ...(minimapDodgesSidebar
                ? { right: mapOptionsOpen ? 228 : 8, transition: 'right 0.2s ease' }
                : {}),
            }}
          />
        )}
      </ReactFlow>

      <div className="map-canvas__hint">{t('ctxMenu.canvasHint')}</div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.screenX}
          y={contextMenu.screenY}
          items={ctxItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingPosition && (
        <AddSystemModal position={pendingPosition} onClose={() => setPendingPosition(null)} />
      )}
    </div>
    </HeatmapContext.Provider>
  );
}
