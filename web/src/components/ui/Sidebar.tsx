import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { DraggableCard } from './DraggableCard';
import { ScoutConnectionsPane } from './ScoutConnectionsPane';
import { A0Pane } from './A0Pane';

const SIDE_KEY      = 'nexum.sidebar.side';
const COLLAPSED_KEY = 'nexum.sidebar.collapsed';
const ORDER_KEY     = 'nexum.sidebar.order';
const WIDTH_KEY     = 'nexum.sidebar.width';

const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 240;

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY);
  if (!raw) return DEFAULT_WIDTH;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

type Side    = 'left' | 'right';
type PanelId = 'thera' | 'turnur' | 'a0';

const DEFAULT_ORDER: PanelId[] = ['thera', 'turnur', 'a0'];
const PANEL_TITLES: Record<PanelId, string> = {
  thera:  'Thera Connections',
  turnur: 'Turnur Connections',
  a0:     'Nearby A0 Suns',
};
const VALID_PANEL_IDS: ReadonlySet<PanelId> = new Set(DEFAULT_ORDER);

function loadOrder(): PanelId[] {
  const raw = localStorage.getItem(ORDER_KEY);
  if (!raw) return DEFAULT_ORDER;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_ORDER;
    const valid: PanelId[] = parsed.filter(
      (id): id is PanelId => typeof id === 'string' && VALID_PANEL_IDS.has(id as PanelId),
    );
    for (const id of DEFAULT_ORDER) if (!valid.includes(id)) valid.push(id);
    return valid;
  } catch {
    return DEFAULT_ORDER;
  }
}

export function Sidebar() {
  const [side, setSide] = useState<Side>(() =>
    localStorage.getItem(SIDE_KEY) === 'right' ? 'right' : 'left',
  );
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem(COLLAPSED_KEY) === 'true',
  );
  const [order, setOrder] = useState<PanelId[]>(loadOrder);
  const [width, setWidth] = useState<number>(loadWidth);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => { localStorage.setItem(SIDE_KEY, side); }, [side]);
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); }, [collapsed]);
  useEffect(() => { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); }, [order]);
  useEffect(() => { localStorage.setItem(WIDTH_KEY, String(width)); }, [width]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // Drag direction is reversed when the sidebar lives on the right —
      // dragging the handle leftward should widen the panel in that case.
      const delta = side === 'left' ? dx : -dx;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + delta)));
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const swapSide = () => setSide(s => (s === 'left' ? 'right' : 'left'));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder(prev =>
      arrayMove(prev, prev.indexOf(active.id as PanelId), prev.indexOf(over.id as PanelId)),
    );
  };

  if (collapsed) {
    return (
      <aside className={`sidebar sidebar--${side} sidebar--collapsed`}>
        <button
          type="button"
          className="sidebar__expand-tab"
          onClick={() => setCollapsed(false)}
          data-tooltip="Expand sidebar"
          aria-label="Expand sidebar"
        >
          {side === 'left' ? '▶' : '◀'}
        </button>
      </aside>
    );
  }

  const cards: Record<PanelId, ReactNode> = {
    thera:  <ScoutConnectionsPane scoutSystem="Thera" />,
    turnur: <ScoutConnectionsPane scoutSystem="Turnur" />,
    a0:     <A0Pane />,
  };

  return (
    <aside className={`sidebar sidebar--${side}`} style={{ width }}>
      <div
        className={`sidebar__resize-handle sidebar__resize-handle--${side}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />
      <div className="sidebar__header">
        <button
          type="button"
          className="icon-btn"
          onClick={swapSide}
          data-tooltip={`Move sidebar to ${side === 'left' ? 'right' : 'left'}`}
          aria-label={`Move sidebar to ${side === 'left' ? 'right' : 'left'}`}
        >
          {side === 'left' ? '⇥' : '⇤'}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCollapsed(true)}
          data-tooltip="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          {side === 'left' ? '◀' : '▶'}
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="sidebar__content">
            {order.map(id => (
              <DraggableCard key={id} id={id} title={PANEL_TITLES[id]}>
                {cards[id]}
              </DraggableCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </aside>
  );
}
