import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Panel,
  useNodesState, useEdgesState, addEdge, BackgroundVariant,
  ConnectionMode, Handle, Position, useConnection, useReactFlow,
  getBezierPath, BaseEdge,
} from '@xyflow/react';
import type { Connection, Edge, EdgeProps, Node, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SystemClass, WormholeEffect } from '../../types';
import {
  CLASS_COLORS, CLASS_LABELS,
  EFFECT_ICONS, EFFECT_LABELS, EFFECT_MODIFIERS,
  WORMHOLE_DESTINATIONS,
} from '../../data/wormholes';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { AddSystemModal } from './AddSystemModal';
import { pickHandles } from '../map/edgeUtils';

interface DemoSys {
  id: string;
  name: string;
  systemClass: SystemClass;
  effect: WormholeEffect;
  statics: string[];
  regionName: string | null;
}

// ── pre-populated chain ──────────────────────────────────────

const SEED_SYSTEMS: DemoSys[] = [
  { id: 'ds1', name: 'J213422',  systemClass: 'C3', effect: 'pulsar',     statics: ['C247', 'Z971'], regionName: null },
  { id: 'ds2', name: 'J123456',  systemClass: 'C2', effect: 'none',       statics: ['D364', 'N766'], regionName: null },
  { id: 'ds3', name: 'J456789',  systemClass: 'C5', effect: 'magnetar',   statics: ['H296'],         regionName: null },
  { id: 'ds4', name: 'Jita',     systemClass: 'HS', effect: 'none',       statics: [],               regionName: 'The Forge' },
  { id: 'ds5', name: 'J789012',  systemClass: 'C4', effect: 'wolf_rayet', statics: ['E175', 'X877'], regionName: null },
];

const SEED_POSITIONS: { x: number; y: number }[] = [
  { x: 300, y: 140 },
  { x: 60,  y: 290 },
  { x: 540, y: 290 },
  { x: -80, y: 430 },
  { x: 700, y: 80  },
];

const INITIAL_NODES: Node[] = SEED_SYSTEMS.map((s, i) => ({
  id: s.id,
  type: 'demoSystem',
  position: SEED_POSITIONS[i],
  data: s as unknown as Record<string, unknown>,
}));

const INITIAL_EDGES: Edge[] = [
  { id: 'de1', source: 'ds1', target: 'ds2', type: 'demoConnection', ...pickHandles(SEED_POSITIONS[0], SEED_POSITIONS[1]) },
  { id: 'de2', source: 'ds1', target: 'ds3', type: 'demoConnection', ...pickHandles(SEED_POSITIONS[0], SEED_POSITIONS[2]) },
  { id: 'de3', source: 'ds2', target: 'ds4', type: 'demoConnection', ...pickHandles(SEED_POSITIONS[1], SEED_POSITIONS[3]) },
];

// ── demo edge ────────────────────────────────────────────────

const EDGE_COLOR = '#8a9ab8';

const DemoConnectionEdge = memo(({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, selected,
}: EdgeProps) => {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: EDGE_COLOR,
        strokeWidth: selected ? 6 : 4,
        filter: selected ? `drop-shadow(0 0 6px ${EDGE_COLOR})` : undefined,
        opacity: selected ? 1 : 0.85,
      }}
    />
  );
});
DemoConnectionEdge.displayName = 'DemoConnectionEdge';

const NODE_TYPES = { demoSystem: DemoSystemNode };
const EDGE_TYPES = { demoConnection: DemoConnectionEdge };

// ── spread helper (same algorithm as the live map) ───────────

function resolveOverlaps(
  items: Array<{ id: string; x: number; y: number; w: number; h: number; locked: boolean }>,
  padding = 24,
) {
  const pos = items.map(n => ({ ...n }));
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

// ── demo node ────────────────────────────────────────────────

function DemoSystemNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const sys = data as unknown as DemoSys;
  const color = CLASS_COLORS[sys.systemClass];
  const connection = useConnection();
  const isTarget = connection.inProgress && connection.fromNode?.id !== sys.id;

  return (
    <div
      className={`system-node${isTarget ? ' system-node--connect-target' : ''}`}
      style={{ '--class-color': color } as React.CSSProperties}
      data-selected={selected}
    >
      <Handle type="source" position={Position.Top}    id="top"    className="system-handle" />
      <Handle type="source" position={Position.Right}  id="right"  className="system-handle" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="system-handle" />
      <Handle type="source" position={Position.Left}   id="left"   className="system-handle" />

      <div className="system-node__header">
        <span className="system-node__class-badge">{CLASS_LABELS[sys.systemClass]}</span>
        {sys.effect !== 'none' && (
          <span className="system-node__effect-icon" style={{ color: EFFECT_ICONS[sys.effect].color }}>
            {EFFECT_ICONS[sys.effect].symbol}
          </span>
        )}
      </div>

      <div className="system-node__name">{sys.name || t('mapNode.unknown')}</div>

      {sys.statics.length > 0 && (
        <div className="system-node__statics">
          <div className="title">{t('systemPanel.statics')}</div>
          {sys.statics.map(s => {
            const dest = WORMHOLE_DESTINATIONS[s];
            return (
              <span key={s} className="system-node__static-tag">
                {s}
                {dest && (
                  <span className="system-node__static-dest" style={{ color: CLASS_COLORS[dest] }}>
                    {dest}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── info panel ───────────────────────────────────────────────

function DemoInfoPanel({ sys, onRemove }: { sys: DemoSys; onRemove: () => void }) {
  const { t } = useTranslation();
  const color = CLASS_COLORS[sys.systemClass];
  const effectIcon = EFFECT_ICONS[sys.effect];
  const effectLabel = EFFECT_LABELS[sys.effect];
  const effectMods = EFFECT_MODIFIERS[sys.effect];

  return (
    <div className="demo-info__content">
      <div className="demo-info__name">{sys.name}</div>
      <div className="demo-info__class" style={{ color }}>
        {CLASS_LABELS[sys.systemClass]}
      </div>

      {sys.effect !== 'none' && (
        <div className="demo-info__effect">
          <span style={{ color: effectIcon.color }}>
            {effectIcon.symbol} {effectLabel}
          </span>
          <div className="demo-info__effect-mods">
            {effectMods.map(m => (
              <span
                key={m.label}
                className={m.good ? 'demo-info__mod--good' : 'demo-info__mod--bad'}
              >
                {m.good ? '▲' : '▼'} {m.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {sys.statics.length > 0 && (
        <div className="demo-info__statics">
          <div className="demo-info__label">{t('systemPanel.statics')}</div>
          {sys.statics.map(s => {
            const dest = WORMHOLE_DESTINATIONS[s];
            return (
              <div key={s} className="demo-info__static-row">
                <span className="demo-info__static-code">{s}</span>
                {dest && (
                  <span style={{ color: CLASS_COLORS[dest] }}>
                    → {CLASS_LABELS[dest]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sys.regionName && (
        <div className="demo-info__section">
          <div className="demo-info__label">{t('systemPanel.region')}</div>
          <div>{sys.regionName}</div>
        </div>
      )}

      <div className="demo-info__more">
        <div className="demo-info__more-icon">✦</div>
        <p>{t('demo.signInMore')}</p>
      </div>

      <button type="button" className="btn btn--ghost demo-info__remove" onClick={onRemove}>
        {t('ctxMenu.removeSystem')}
      </button>
    </div>
  );
}

function DemoInfoHint() {
  const { t } = useTranslation();
  return (
    <div className="demo-info__hint">
      <p>{t('demo.hintClick')}</p>
      <p>{t('demo.hintAdd')}</p>
      <p>{t('demo.hintConnect')}</p>
      <p className="demo-info__hint-limit">{t('demo.hintLimit', { count: DEMO_MAX_SYSTEMS })}</p>
    </div>
  );
}

// ── main inner component (needs to be inside ReactFlowProvider) ──

const DEMO_MAX_SYSTEMS = 10;

let demoIdSeq = 200;

interface CtxMenu { x: number; y: number; nodeId?: string }
interface AddFormState { flowX: number; flowY: number }

function DemoMapInner() {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  // Translate the zoom / fit control tooltips (see MapCanvas for the same).
  const ariaLabelConfig = useMemo(() => ({
    'controls.ariaLabel':         t('mapControls.panel'),
    'controls.zoomIn.ariaLabel':  t('mapControls.zoomIn'),
    'controls.zoomOut.ariaLabel': t('mapControls.zoomOut'),
    'controls.fitView.ariaLabel': t('mapControls.fitView'),
  }), [t]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [addForm, setAddForm] = useState<AddFormState | null>(null);

  const selectedSys = selectedId
    ? (nodes.find(n => n.id === selectedId)?.data as unknown as DemoSys | undefined) ?? null
    : null;

  const optimizeEdges = useCallback((posMap: Map<string, { x: number; y: number }>) => {
    setEdges(eds => eds.map(edge => {
      const src = posMap.get(edge.source);
      const tgt = posMap.get(edge.target);
      if (!src || !tgt) return edge;
      return { ...edge, ...pickHandles(src, tgt) };
    }));
  }, [setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const srcNode = nodes.find(n => n.id === connection.source);
      const tgtNode = nodes.find(n => n.id === connection.target);
      const handles = srcNode && tgtNode ? pickHandles(srcNode.position, tgtNode.position) : {};
      setEdges(eds => addEdge({ ...connection, type: 'demoConnection', ...handles }, eds));
    },
    [nodes, setEdges],
  );

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, _node: Node, movedNodes: Node[]) => {
      const movedIds = new Set(movedNodes.map(n => n.id));
      const posMap = new Map(nodes.map(n => [n.id, n.position]));
      movedNodes.forEach(n => posMap.set(n.id, n.position));
      setEdges(eds => eds.map(edge => {
        if (!movedIds.has(edge.source) && !movedIds.has(edge.target)) return edge;
        const src = posMap.get(edge.source);
        const tgt = posMap.get(edge.target);
        if (!src || !tgt) return edge;
        return { ...edge, ...pickHandles(src, tgt) };
      }));
    },
    [nodes, setEdges],
  );

  const spreadNodes = useCallback(() => {
    const rfNodes = getNodes();
    if (rfNodes.length < 2) return;
    const items = rfNodes.map(n => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: n.measured?.width  ?? 150,
      h: n.measured?.height ?? 100,
      locked: false,
    }));
    const resolved = resolveOverlaps(items);
    setNodes(ns => ns.map(n => {
      const r = resolved.find(r => r.id === n.id);
      return r ? { ...n, position: { x: r.x, y: r.y } } : n;
    }));
    optimizeEdges(new Map(resolved.map(r => [r.id, { x: r.x, y: r.y }])));
  }, [getNodes, setNodes, optimizeEdges]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id);
    setCtxMenu(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setCtxMenu(null);
    setSelectedId(null);
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setSelectedId(node.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const me = e as React.MouseEvent;
    const flowPos = screenToFlowPosition({ x: me.clientX, y: me.clientY });
    setCtxMenu({ x: me.clientX, y: me.clientY, nodeId: undefined });
    pendingFlowPos.current = flowPos;
  }, [screenToFlowPosition]);

  const pendingFlowPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const atLimit = nodes.length >= DEMO_MAX_SYSTEMS;

  const openAddForm = useCallback(() => {
    setCtxMenu(null);
    if (nodes.length >= DEMO_MAX_SYSTEMS) return;
    setAddForm({ flowX: pendingFlowPos.current.x, flowY: pendingFlowPos.current.y });
  }, [nodes.length]);

  const removeNode = useCallback((nodeId: string) => {
    setNodes(ns => ns.filter(n => n.id !== nodeId));
    setEdges(es => es.filter(e => e.source !== nodeId && e.target !== nodeId));
    if (selectedId === nodeId) setSelectedId(null);
    setCtxMenu(null);
  }, [setNodes, setEdges, selectedId]);

  const ctxItems: ContextMenuItem[] = ctxMenu?.nodeId
    ? [{ label: t('ctxMenu.removeSystem'), icon: '✕', action: () => removeNode(ctxMenu.nodeId!) }]
    : [{ label: atLimit ? t('demo.addSystemLimit', { max: DEMO_MAX_SYSTEMS }) : t('demo.addSystemHere'), icon: '+', action: openAddForm, disabled: atLimit }];

  return (
    <div className="demo-wrap">
      <div className="demo-info demo-info--visible">
        {selectedSys
          ? <DemoInfoPanel sys={selectedSys} onRemove={() => removeNode(selectedId!)} />
          : <DemoInfoHint />
        }
      </div>

      <div className="demo-canvas-wrap">
        <ReactFlow
          ariaLabelConfig={ariaLabelConfig}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          connectionMode={ConnectionMode.Loose}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.4}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1a2535" />
          <Controls showInteractive={false} />
          <Panel position="top-right">
            <div className="demo-map-actions">
              <button type="button" className="map-sidebar__action" onClick={spreadNodes} disabled={nodes.length < 2} data-tooltip={t('mapSidebar.spreadNodesTooltip')}>
                {t('mapSidebar.spreadNodes')}
              </button>
              <span className={`demo-map-actions__count${atLimit ? ' demo-map-actions__count--limit' : ''}`}>
                {t('demo.systemsCount', { count: nodes.length, max: DEMO_MAX_SYSTEMS })}
              </span>
            </div>
          </Panel>
        </ReactFlow>

        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={ctxItems}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>

      {addForm && (
        <AddSystemModal
          position={{ x: addForm.flowX, y: addForm.flowY }}
          onClose={() => setAddForm(null)}
          onSubmit={(name, systemClass, position, opts) => {
            const id = `demo-u${++demoIdSeq}`;
            const sys: DemoSys = {
              id,
              name,
              systemClass,
              effect: (opts.effect ?? 'none') as WormholeEffect,
              statics: opts.statics ?? [],
              regionName: opts.regionName ?? null,
            };
            setNodes(ns => [...ns, { id, type: 'demoSystem', position, data: sys as unknown as Record<string, unknown> }]);
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}

// ── public export ────────────────────────────────────────────

export function DemoMap() {
  return (
    <ReactFlowProvider>
      <DemoMapInner />
    </ReactFlowProvider>
  );
}
