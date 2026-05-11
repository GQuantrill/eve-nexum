import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, BackgroundVariant, useReactFlow, ConnectionMode,
  applyNodeChanges,
} from '@xyflow/react';
import type { Connection, Node, Edge, EdgeChange, NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useMapStore } from '../../store/mapStore';
import { SystemNode } from './SystemNode';
import { ConnectionEdge } from './ConnectionEdge';
import { AddSystemModal } from '../ui/AddSystemModal';
import { ContextMenu } from '../ui/ContextMenu';
import type { MapSystem } from '../../types';
import { CLASS_COLORS } from '../../data/wormholes';
import { setDestination, addWaypoint } from '../../api/waypoint';

const NODE_TYPES = { system: SystemNode };

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

function systemToNode(sys: MapSystem, selectedId: string | null, easyConnect = false): Node {
  return {
    id: sys.id,
    type: 'system',
    position: sys.position,
    data: { ...sys, selected: sys.id === selectedId },
    draggable: !sys.locked,
    dragHandle: easyConnect ? '.drag-handle' : undefined,
  };
}

export function MapCanvas() {
  const { map, selectedSystemId, selectedConnectionId, snapToGrid, showMinimap, easyConnect, mapOptionsOpen, edgeStyle, addConnection, moveSystem, lockSystem, updateSystem, removeSystem, removeConnection, updateConnection, undo, autoLayoutPending, clearAutoLayoutPending, pushUndo } = useMapStore();
  const { screenToFlowPosition, setViewport, getNode, getNodes, getZoom } = useReactFlow();

  const [pendingPosition, setPendingPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu]         = useState<CtxMenu | null>(null);

  const initialNodes = useMemo(
    () => map.systems.map((s) => systemToNode(s, selectedSystemId, easyConnect)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [nodes, setNodes] = useNodesState(initialNodes);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      changes.forEach((c) => {
        if (c.type === 'remove') {
          const sys = map.systems.find((s) => s.id === c.id);
          if (!sys?.locked) removeSystem(c.id);
        }
      });
      setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
    },
    [map.systems, removeSystem, setNodes],
  );

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

        // Multi-select: remove all RF-selected non-locked nodes
        const rfSelected = nodes.filter((n) => n.selected);
        if (rfSelected.length > 0) {
          rfSelected.forEach((n) => {
            const sys = map.systems.find((s) => s.id === n.id);
            if (!sys?.locked) removeSystem(n.id);
          });
          return;
        }

        // Single-click selected (panel open)
        if (selectedSystemId) {
          const sys = map.systems.find((s) => s.id === selectedSystemId);
          if (sys && !sys.locked) removeSystem(selectedSystemId);
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [nodes, selectedSystemId, map.systems, removeSystem, undo, setNodes]);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    if (shiftHeld.current && sel.length > 0) pendingSelection.current = sel.map((n) => n.id);
  }, []);

  useEffect(() => {
    setNodes(map.systems.map((s) => systemToNode(s, selectedSystemId, easyConnect)));
  }, [map.systems, selectedSystemId, easyConnect, setNodes]);

  const centerOnSystem = useCallback((systemId: string) => {
    const node = getNode(systemId);
    if (!node) return false;

    const zoom   = getZoom();
    const flowX  = node.position.x + (node.measured?.width  ?? 150) / 2;
    const flowY  = node.position.y + (node.measured?.height ?? 80)  / 2;

    // Measure the visible canvas area, subtracting the system panel that
    // overlays the bottom so the node lands in the centre of what's visible.
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

  useEffect(() => {
    if (!selectedSystemId) return;
    // For newly-added nodes React Flow needs one frame to commit the node
    // before getNode can find it.
    if (!centerOnSystem(selectedSystemId)) {
      const raf = requestAnimationFrame(() => centerOnSystem(selectedSystemId));
      return () => cancelAnimationFrame(raf);
    }
  }, [selectedSystemId, centerOnSystem]);

  useEffect(() => {
    if (!autoLayoutPending) return;
    clearAutoLayoutPending();

    const rfNodes = getNodes();
    if (rfNodes.length < 2) return;

    const items = rfNodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: n.measured?.width  ?? 150,
      h: n.measured?.height ?? 100,
      locked: map.systems.find((s) => s.id === n.id)?.locked ?? false,
    }));

    const resolved = resolveOverlaps(items);

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
  }, [autoLayoutPending, clearAutoLayoutPending, getNodes, map.systems, moveSystem, pushUndo]);

  // Edges driven directly from store — no local duplicate state
  const edges = useMemo(
    () =>
      map.connections.map((c) => ({
        id: c.id,
        source: c.sourceId,
        target: c.targetId,
        sourceHandle: c.sourceHandle ?? undefined,
        targetHandle: c.targetHandle ?? undefined,
        type: 'connection',
        data: { ...c, edgeStyle } as unknown as Record<string, unknown>,
        selected: c.id === selectedConnectionId,
      })),
    [map.connections, selectedConnectionId, edgeStyle],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      changes.forEach((change) => {
        if (change.type === 'remove') removeConnection(change.id);
      });
    },
    [removeConnection],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      // Strip easy-connect handle IDs — they don't exist in normal mode,
      // which would cause the edge to render from the wrong position after toggling.
      const EASY = new Set(['easy-source', 'easy-target']);
      const srcH = params.sourceHandle && !EASY.has(params.sourceHandle) ? params.sourceHandle : null;
      const tgtH = params.targetHandle && !EASY.has(params.targetHandle) ? params.targetHandle : null;
      addConnection(params.source, params.target, srcH, tgtH);
    },
    [addConnection],
  );

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, _node: Node, movedNodes: Node[]) => {
      movedNodes.forEach((n) => moveSystem(n.id, n.position));
    },
    [moveSystem],
  );

  const nodeCtxFired = useRef(false);

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      e.stopPropagation();
      nodeCtxFired.current = true;
      setTimeout(() => { nodeCtxFired.current = false; }, 0);
      const selectedNodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, nodeId: node.id, selectedNodeIds });
    },
    [nodes],
  );

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (nodeCtxFired.current) return;
      e.preventDefault();
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: flow.x, flowY: flow.y });
    },
    [screenToFlowPosition],
  );

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, selectedNodes: Node[]) => {
      e.preventDefault();
      e.stopPropagation();
      nodeCtxFired.current = true;
      setTimeout(() => { nodeCtxFired.current = false; }, 0);
      const selectedNodeIds = selectedNodes.map((n) => n.id);
      // Use the first node as the "primary" so single-node items still work
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, nodeId: selectedNodeIds[0], selectedNodeIds });
    },
    [],
  );

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: 0, flowY: 0, edgeId: edge.id });
    },
    [],
  );

  const onPaneClick = useCallback(() => setContextMenu(null), []);

  const ctxItems = (() => {
    if (!contextMenu) return [];

    if (contextMenu.edgeId) {
      const conn = map.connections.find((c) => c.id === contextMenu.edgeId);
      const isJumpgate  = conn?.connectionType === 'jumpgate';
      const timeStatus  = conn?.timeStatus  ?? 'fresh';
      const massStatus  = conn?.massStatus  ?? 'stable';
      const eid = contextMenu.edgeId;
      return [
        {
          label: 'Disconnect',
          icon: '✕',
          action: () => removeConnection(eid),
        },
        { separator: true as const },
        {
          label: 'Jump Type',
          submenu: [
            {
              label: 'Standard Jump',
              checked: !isJumpgate,
              action: () => updateConnection(eid, { connectionType: 'standard' }),
            },
            {
              label: 'Jumpgate',
              checked: isJumpgate,
              action: () => updateConnection(eid, { connectionType: 'jumpgate' }),
            },
          ],
        },
        {
          label: 'Wormhole Lifetime',
          submenu: [
            {
              label: 'Less than 1 day remaining',
              checked: timeStatus === 'lessThan24h',
              action: () => updateConnection(eid, { timeStatus: 'lessThan24h' }),
            },
            {
              label: 'Less than 4 hours remaining',
              checked: timeStatus === 'lessThan4h',
              action: () => updateConnection(eid, { timeStatus: 'lessThan4h' }),
            },
            {
              label: 'Less than 1 hour remaining',
              checked: timeStatus === 'lessThan1h',
              action: () => updateConnection(eid, { timeStatus: 'lessThan1h' }),
            },
            {
              label: 'Expired, closure imminent',
              checked: timeStatus === 'expired',
              action: () => updateConnection(eid, { timeStatus: 'expired' }),
            },
          ],
        },
        {
          label: 'Mass Stability',
          submenu: [
            {
              label: 'More than 50% remaining',
              checked: massStatus === 'stable',
              action: () => updateConnection(eid, { massStatus: 'stable' }),
            },
            {
              label: 'Less than 50% remaining',
              checked: massStatus === 'destabilized',
              action: () => updateConnection(eid, { massStatus: 'destabilized' }),
            },
            {
              label: 'Less than 10% remaining',
              checked: massStatus === 'critical',
              action: () => updateConnection(eid, { massStatus: 'critical' }),
            },
          ],
        },
      ];
    }

    if (contextMenu.nodeId) {
      const sys = map.systems.find((s) => s.id === contextMenu.nodeId);
      const selectedNodeIds = contextMenu.selectedNodeIds ?? [contextMenu.nodeId];
      const selectedNodes   = nodes.filter((n) => selectedNodeIds.includes(n.id));
      const multiSelected   = selectedNodes.length > 1;

      const waypointItems = !multiSelected && sys?.eveSystemId ? [
        { separator: true as const },
        {
          label: 'Set Destination',
          icon: '🎯',
          action: () => setDestination(sys.eveSystemId!).catch(console.error),
        },
        {
          label: 'Add Waypoint',
          icon: '📍',
          action: () => addWaypoint(sys.eveSystemId!).catch(console.error),
        },
      ] : [];

      const multiItems = multiSelected ? [
        { separator: true as const },
        {
          label: `Lock ${selectedNodes.length} Selected`,
          icon: '🔒',
          action: () => selectedNodes.forEach((n) => updateSystem(n.id, { locked: true })),
        },
        {
          label: `Unlock ${selectedNodes.length} Selected`,
          icon: '🔓',
          action: () => selectedNodes.forEach((n) => updateSystem(n.id, { locked: false })),
        },
      ] : [];

      return [
        {
          label: sys?.locked ? 'Unlock System' : 'Lock System',
          icon:  sys?.locked ? '🔓' : '🔒',
          action: () => lockSystem(contextMenu.nodeId!),
        },
        ...(!sys?.locked ? [{
          label: multiSelected ? `Remove ${selectedNodes.filter((n) => !map.systems.find((s) => s.id === n.id)?.locked).length} Systems` : 'Remove System',
          icon: '✕',
          action: () => {
            if (multiSelected) {
              selectedNodes
                .filter((n) => !map.systems.find((s) => s.id === n.id)?.locked)
                .forEach((n) => removeSystem(n.id));
            } else {
              removeSystem(contextMenu.nodeId!);
            }
          },
        }] : []),
        ...multiItems,
        ...waypointItems,
      ];
    }

    return [
      {
        label: 'Add System',
        icon: '+',
        action: () => setPendingPosition({ x: contextMenu.flowX - 75, y: contextMenu.flowY - 40 }),
      },
      {
        label: 'Select All',
        icon: '⊞',
        action: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
        disabled: nodes.length === 0,
      },
    ];
  })();

  return (
    <div className="map-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        proOptions={{ hideAttribution: true }}
        onSelectionContextMenu={onSelectionContextMenu}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        connectionMode={ConnectionMode.Loose}
        multiSelectionKeyCode="Shift"
        selectionKeyCode="Shift"
        snapToGrid={snapToGrid}
        snapGrid={[20, 20]}
        fitView
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={null}
      >
        <Background
          variant={snapToGrid ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={snapToGrid ? 20 : 24}
          size={snapToGrid ? 1 : 1}
          color={snapToGrid ? '#1a2240' : '#1a2040'}
        />
        <Controls />
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const sys = map.systems.find((s) => s.id === n.id);
              return sys ? CLASS_COLORS[sys.systemClass] : '#333';
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
              right: mapOptionsOpen ? 228 : 8,
              transition: 'right 0.2s ease',
            }}
          />
        )}
      </ReactFlow>

      <div className="map-canvas__hint">Right-click canvas to add system · Drag between handles to connect · Shift+click or drag to multi-select · Right click system to interact</div>

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
  );
}
