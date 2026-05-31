import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, Modifier } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { DraggableCard } from './DraggableCard';
import { ScoutConnectionsPane } from './ScoutConnectionsPane';
import { A0Pane } from './A0Pane';
import { ClosestSystemsPane } from './ClosestSystemsPane';
import { CaretLeftIcon, CaretRightIcon, ArrowLineLeftIcon, ArrowLineRightIcon } from '@phosphor-icons/react';
import { useUserSetting } from '../../hooks/useUserSetting';

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
type PanelId = 'thera' | 'turnur' | 'a0' | 'closest';

const DEFAULT_ORDER: PanelId[] = ['closest', 'thera', 'turnur', 'a0'];
const VALID_PANEL_IDS: ReadonlySet<PanelId> = new Set(DEFAULT_ORDER);

// The panels form a single vertical column, so a drag should only ever move a
// card up or down. Zeroing the X component locks dragging to the vertical axis
// — both the card's visual transform and dnd-kit's collision detection. This
// is the same one-liner @dnd-kit/modifiers' restrictToVerticalAxis ships, kept
// inline to avoid the extra dependency.
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function sanitiseOrder(raw: unknown): PanelId[] {
  if (!Array.isArray(raw)) return DEFAULT_ORDER;
  const valid: PanelId[] = raw.filter(
    (id): id is PanelId => typeof id === 'string' && VALID_PANEL_IDS.has(id as PanelId),
  );
  for (const id of DEFAULT_ORDER) if (!valid.includes(id)) valid.push(id);
  return valid;
}

export function Sidebar() {
  const { t } = useTranslation();
  const panelTitle: Record<PanelId, string> = {
    thera:   t('sidebar.thera'),
    turnur:  t('sidebar.turnur'),
    a0:      t('sidebar.a0'),
    closest: t('sidebar.closest'),
  };
  // Cross-device prefs via useUserSetting (server-backed JSONB).
  const [sideRaw,      setSide]      = useUserSetting<Side>(SIDE_KEY, 'left');
  const side: Side = sideRaw === 'right' ? 'right' : 'left';
  const [collapsed,    setCollapsed] = useUserSetting<boolean>(COLLAPSED_KEY, false);
  const [orderRaw,     setOrder]     = useUserSetting<PanelId[]>(ORDER_KEY, DEFAULT_ORDER);
  const order = sanitiseOrder(orderRaw);
  // Width stays per-device — different monitors / window widths want
  // different sizes.
  const [width, setWidth] = useState<number>(loadWidth);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
    // Reorder the *sanitised* order the user actually sees — not the raw
    // stored value, which may be missing panels added since they last saved
    // (sanitiseOrder appends those at the bottom). Operating on the raw value
    // makes indexOf return -1 for an appended panel, so its drags never stick.
    const from = order.indexOf(active.id as PanelId);
    const to   = order.indexOf(over.id as PanelId);
    if (from === -1 || to === -1) return;
    setOrder(arrayMove(order, from, to));
  };

  if (collapsed) {
    return (
      <aside className={`sidebar sidebar--${side} sidebar--collapsed`}>
        <button
          type="button"
          className="sidebar__expand-tab"
          onClick={() => setCollapsed(false)}
          data-tooltip={t('sidebar.expand')}
          aria-label={t('sidebar.expand')}
        >
          {side === 'left'
            ? <CaretRightIcon size={14} weight="bold" />
            : <CaretLeftIcon  size={14} weight="bold" />}
        </button>
      </aside>
    );
  }

  const cards: Record<PanelId, ReactNode> = {
    thera:   <ScoutConnectionsPane scoutSystem="Thera" />,
    turnur:  <ScoutConnectionsPane scoutSystem="Turnur" />,
    a0:      <A0Pane />,
    closest: <ClosestSystemsPane />,
  };

  return (
    <aside className={`sidebar sidebar--${side}`} style={{ width }}>
      <div
        className={`sidebar__resize-handle sidebar__resize-handle--${side}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
      />
      <div className="sidebar__header">
        <button
          type="button"
          className="icon-btn"
          onClick={swapSide}
          data-tooltip={side === 'left' ? t('sidebar.moveToRight') : t('sidebar.moveToLeft')}
          aria-label={side === 'left' ? t('sidebar.moveToRight') : t('sidebar.moveToLeft')}
        >
          {side === 'left'
            ? <ArrowLineRightIcon size={14} weight="bold" />
            : <ArrowLineLeftIcon  size={14} weight="bold" />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCollapsed(true)}
          data-tooltip={t('sidebar.collapse')}
          aria-label={t('sidebar.collapse')}
        >
          {side === 'left'
            ? <CaretLeftIcon  size={14} weight="bold" />
            : <CaretRightIcon size={14} weight="bold" />}
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="sidebar__content">
            {order.map(id => (
              <DraggableCard key={id} id={id} title={panelTitle[id]}>
                {cards[id]}
              </DraggableCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </aside>
  );
}
