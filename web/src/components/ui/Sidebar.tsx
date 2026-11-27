import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, Modifier } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { DraggableCard } from './DraggableCard';
import { ScoutConnectionsPane } from './ScoutConnectionsPane';
import { PilotsOnlinePane } from './PilotsOnlinePane';
import { ClonesPane } from './ClonesPane';
import { A0Pane } from './A0Pane';
import { UsefulSystemsPane } from './UsefulSystemsPane';
import { ClosestSystemsPane } from './ClosestSystemsPane';
import { FleetPane } from './FleetPane';
import { WatchlistBlock } from './WatchlistBlock';
import { ChainsPane } from './ChainsPane';
import { RoutePlannerPane } from './RoutePlannerPane';
import { IntelPane } from './IntelPane';
import { isDesktop } from '../../desktop/bridge';
import { CaretLeftIcon, CaretRightIcon, ArrowLineLeftIcon, ArrowLineRightIcon, SquaresFourIcon } from '../../icons';
import { PanelVisibilityModal } from './PanelVisibilityModal';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useAuth } from '../../context/AuthContext';
import { popOut, bringBack, usePoppedOut } from '../../utils/popout';

const SIDE_KEY      = 'nexum.sidebar.side';
const COLLAPSED_KEY = 'nexum.sidebar.collapsed';
const ORDER_KEY     = 'nexum.sidebar.order';
const WIDTH_KEY     = 'nexum.sidebar.width';
const HIDDEN_KEY    = 'nexum.sidebar.hidden';

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
type PanelId = 'watchlist' | 'intel' | 'routePlanner' | 'chains' | 'thera' | 'turnur' | 'a0' | 'closest' | 'useful' | 'fleet' | 'pilotsOnline' | 'clones';

const DEFAULT_ORDER: PanelId[] = ['watchlist', 'intel', 'routePlanner', 'chains', 'closest', 'useful', 'thera', 'turnur', 'fleet', 'pilotsOnline', 'clones', 'a0'];
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

/** Each pane's content: the same in the sidebar and in a pop-out window. */
function cardFor(id: PanelId): ReactNode {
  switch (id) {
    case 'watchlist': return <WatchlistBlock />;
    case 'intel': return <IntelPane />;
    case 'routePlanner': return <RoutePlannerPane />;
    case 'chains': return <ChainsPane />;
    case 'thera': return <ScoutConnectionsPane scoutSystem="Thera" />;
    case 'turnur': return <ScoutConnectionsPane scoutSystem="Turnur" />;
    case 'a0': return <A0Pane />;
    case 'closest': return <ClosestSystemsPane />;
    case 'useful': return <UsefulSystemsPane />;
    case 'fleet': return <FleetPane />;
    case 'pilotsOnline': return <PilotsOnlinePane />;
    case 'clones': return <ClonesPane />;
  }
}

function usePanelTitles(): Record<PanelId, string> {
  const { t } = useTranslation();
  return {
    watchlist: t('sidebar.watchlist'),
    intel: t('sidebar.intel'),
    routePlanner: t('sidebar.routePlanner'),
    chains:  t('sidebar.chains'),
    thera:   t('sidebar.thera'),
    turnur:  t('sidebar.turnur'),
    a0:      t('sidebar.a0'),
    closest: t('sidebar.closest'),
    useful:  t('sidebar.useful'),
    fleet:   t('sidebar.fleet'),
    pilotsOnline: t('pilotsOnline.title'),
    clones: t('clones.title'),
  };
}

/** A pane on its own, filling a pop-out window (utils/popout.ts). */
export function PopoutView({ id }: { id: string }) {
  const { t } = useTranslation();
  const titles = usePanelTitles();
  const valid = VALID_PANEL_IDS.has(id as PanelId);
  const title = valid ? titles[id as PanelId] : '';
  useEffect(() => { if (title) document.title = `${title} - Nexum`; }, [title]);
  return (
    <div className="popout">
      <div className="popout__header">
        <span className="popout__title">{title}</span>
        {valid && (
          <button type="button" className="btn btn--ghost popout__back" onClick={() => bringBack(id)}>
            {t('sidebar.bringBack')}
          </button>
        )}
      </div>
      <div className="popout__body">{valid ? cardFor(id as PanelId) : null}</div>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const poppedOut = usePoppedOut();
  const panelTitle = usePanelTitles();
  // Cross-device prefs via useUserSetting (server-backed JSONB).
  const [sideRaw,      setSide]      = useUserSetting<Side>(SIDE_KEY, 'left');
  const side: Side = sideRaw === 'right' ? 'right' : 'left';
  const [collapsed,    setCollapsed] = useUserSetting<boolean>(COLLAPSED_KEY, false);
  const [orderRaw,     setOrder]     = useUserSetting<PanelId[]>(ORDER_KEY, DEFAULT_ORDER);
  const order = sanitiseOrder(orderRaw);
  // Store what's HIDDEN, not what's shown, so a section added in a later
  // release is visible by default instead of silently missing.
  const [hiddenRaw, setHidden] = useUserSetting<PanelId[]>(HIDDEN_KEY, []);
  const hidden = useMemo(
    () => new Set((Array.isArray(hiddenRaw) ? hiddenRaw : []).filter(
      (id): id is PanelId => VALID_PANEL_IDS.has(id as PanelId))),
    [hiddenRaw],
  );
  const togglePanel = (id: PanelId) =>
    setHidden((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  const [panelsOpen, setPanelsOpen] = useState(false);
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

  // Presence is an org feature: the server lists nobody unless Nexum is deployed
  // for a corp or an alliance (see the pilots-online route). Rendering the panel
  // regardless would leave a permanently empty card holding sidebar space on a
  // personal or public install. Hide it there instead.
  //
  // Filtered at render rather than removed from the saved order, so it reappears
  // in the position the user put it if the deployment later gains a corp or
  // alliance.
  const orgInstall = !!user?.corpMode || !!user?.allianceMode;
  // The intel feed reads the pilot's EVE chat logs, which only the desktop
  // app can: in a browser it isn't offered at all.
  const desktop    = isDesktop();
  const available  = order.filter((id) => (id !== 'pilotsOnline' || orgInstall) && (id !== 'intel' || desktop));
  // Hidden sections are filtered at render and kept in the saved order, so
  // switching one back on returns it to where the user had it.
  const visibleOrder = available.filter((id) => !hidden.has(id));


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
          onClick={() => setPanelsOpen(true)}
          data-tooltip={t('sidebar.panelsTitle')}
          aria-label={t('sidebar.panelsTitle')}
        >
          <SquaresFourIcon size={14} weight="bold" />
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
        <SortableContext items={visibleOrder} strategy={verticalListSortingStrategy}>
          <div className="sidebar__content">
            {visibleOrder.length === 0 ? (
              // Everything switched off leaves a blank column that reads as a
              // bug. Say what happened, and put the way back right here rather
              // than relying on the header icon being recognised.
              <div className="sidebar__empty">
                <p>{t('sidebar.emptyTitle')}</p>
                <button type="button" className="btn btn--ghost" onClick={() => setPanelsOpen(true)}>
                  {t('sidebar.panelsTitle')}
                </button>
              </div>
            ) : visibleOrder.map(id => (
              poppedOut.includes(id) ? (
                // Open in a window of its own: a stub here, with the way back.
                <DraggableCard key={id} id={id} title={panelTitle[id]}>
                  <div className="sidebar__popped">
                    <span>{t('sidebar.poppedOut')}</span>
                    <button type="button" className="btn btn--ghost" onClick={() => bringBack(id)}>
                      {t('sidebar.bringBack')}
                    </button>
                  </div>
                </DraggableCard>
              ) : (
                <DraggableCard
                  key={id}
                  id={id}
                  title={panelTitle[id]}
                  onUndock={() => popOut(id, panelTitle[id])}
                  undockLabel={t('sidebar.popOut')}
                >
                  {cardFor(id)}
                </DraggableCard>
              )
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {panelsOpen && (
        <PanelVisibilityModal
          title={t('sidebar.panelsTitle')}
          hint={t('sidebar.panelsHint')}
          panels={available.map((id) => ({ id, title: panelTitle[id] }))}
          isVisible={(id) => !hidden.has(id)}
          onToggle={togglePanel}
          onClose={() => setPanelsOpen(false)}
        />
      )}
    </aside>
  );
}
