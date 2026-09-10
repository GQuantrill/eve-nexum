import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../../api/client';
import { useUserSetting } from '../../hooks/useUserSetting';
import styles from './ActivityPane.module.css';

interface HoverState { index: number; xPct: number; yPct: number; value: number }

interface HourlyPoint {
  hour:      number;
  jumps:     number;
  shipKills: number;
  podKills:  number;
  npcKills:  number;
}

const VB_W   = 300;
const VB_H   = 120;
const PAD    = { top: 10, right: 6, bottom: 22, left: 42 };
const IW     = VB_W - PAD.left - PAD.right;
const IH     = VB_H - PAD.top  - PAD.bottom;
const SLOTS  = 24; // always render a 24-slot x-axis

// Fixed x-axis tick positions (hours-ago, right-anchored)
const X_TICKS = [0, 4, 8, 12, 16, 20];

function MiniLineChart({ id, title, values, color, signed = false }: {
  /** Sortable id — the chart key. Charts reorder by drag, so each needs one. */
  id:      string;
  title:   string;
  values:  number[];
  color:   string;
  /** When true, the y-axis is symmetric around 0 — negatives plot below a
   *  zero baseline instead of the usual average line. Used for delta-style
   *  series where the sign carries meaning. */
  signed?: boolean;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const [hover, setHover] = useState<HoverState | null>(null);
  const n      = values.length;
  const avg    = n > 0 ? values.reduce((s, v) => s + v, 0) / n : 0;

  // slot 0 = oldest (left), slot SLOTS-1 = current hour (right)
  // data is right-aligned: data point i maps to slot (SLOTS - n + i)
  const xOfSlot = (slot: number) => PAD.left + (slot / (SLOTS - 1)) * IW;
  const xOfIdx  = (i:    number) => xOfSlot(SLOTS - n + i);
  const slotOfIdx = (i: number) => SLOTS - n + i;

  // Two y-axis modes:
  //   unsigned (default) — 0..maxVal, classic line over zero
  //   signed             — −maxAbs..+maxAbs, zero line in the middle
  const maxVal = signed
    ? Math.max(...values.map(Math.abs), 1)
    : Math.max(...values, 1);
  const minVal = signed ? -maxVal : 0;
  const span   = maxVal - minVal;
  const yOf    = (v: number) => PAD.top + IH - ((v - minVal) / span) * IH;

  const baselineY = signed ? yOf(0)   : (n > 0 ? yOf(avg) : PAD.top + IH);
  const baselineColor = signed ? '#3a4a68' : '#f0a030';
  // Dedupe — at low maxVal the rounding collapses adjacent ticks to the same
  // integer (e.g. [0,0,1,1]), which would also produce duplicate React keys.
  const yTicks = [...new Set(
    signed
      ? [-maxVal, -maxVal / 2, 0, maxVal / 2, maxVal].map((v) => Math.round(v))
      : [0, 1, 2, 3].map((t) => Math.round((maxVal / 3) * t)),
  )];
  const polyline = values.map((v, i) => `${xOfIdx(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');

  return (
    <div
      ref={setNodeRef}
      className={styles.chart}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex:  isDragging ? 10 : undefined,
      }}
    >
      <div className={styles.titleRow}>
        <div className={styles.title}>{title}</div>
        {/* Handle rather than whole-card drag: the plot itself is covered in
            hover targets for the per-point tooltip. */}
        <button
          type="button"
          className={styles.dragHandle}
          {...listeners}
          {...attributes}
          title={t('closest.dragToReorder')}
        >
          ⠿
        </button>
      </div>
      <div className={styles.plot}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid + Y labels */}
        {yTicks.map((v) => (
          <g key={`tick-${v}`}>
            <line
              x1={PAD.left} y1={yOf(v)} x2={PAD.left + IW} y2={yOf(v)}
              stroke="#1a2535" strokeWidth={0.5}
            />
            <text x={PAD.left - 3} y={yOf(v) + 3.5} textAnchor="end" fontSize={11} fill="#7a90a8">
              {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
            </text>
          </g>
        ))}

        {/* Baseline — average (orange dashed) for unsigned series, zero
            line (neutral) for signed delta series. */}
        {n > 0 && (
          <line
            x1={PAD.left} y1={baselineY} x2={PAD.left + IW} y2={baselineY}
            stroke={baselineColor} strokeWidth={1} strokeDasharray="4 3" opacity={0.8}
          />
        )}

        {/* Current-hour marker (right edge) */}
        <line
          x1={xOfSlot(SLOTS - 1)} y1={PAD.top}
          x2={xOfSlot(SLOTS - 1)} y2={PAD.top + IH}
          stroke="#2e4060" strokeWidth={1} strokeDasharray="2 2"
        />

        {/* Data line */}
        {n > 1 && (
          <polyline points={polyline} fill="none" stroke={color} strokeWidth={1.5} />
        )}

        {/* Crosshair on the hovered point */}
        {hover && (
          <line
            x1={xOfIdx(hover.index)} y1={PAD.top}
            x2={xOfIdx(hover.index)} y2={PAD.top + IH}
            stroke={color} strokeWidth={0.8} opacity={0.4}
            pointerEvents="none"
          />
        )}

        {/* Visible dot + a larger transparent hit-target so 24 ticks are
            still easy to mouse onto. */}
        {values.map((v, i) => {
          const cx = xOfIdx(i);
          const cy = yOf(v);
          const isActive = hover?.index === i;
          return (
            <g key={`pt-${i}`}>
              <circle cx={cx} cy={cy} r={isActive ? 3.4 : 2.2}
                fill={color} stroke="#08090f" strokeWidth={0.8}
                pointerEvents="none" />
              <circle cx={cx} cy={cy} r={8}
                fill="transparent"
                onMouseEnter={() => setHover({
                  index: i,
                  value: v,
                  xPct:  (cx / VB_W) * 100,
                  yPct:  (cy / VB_H) * 100,
                })}
              />
            </g>
          );
        })}

        {/* Fixed X-axis labels (right-anchored, hours-ago) */}
        {X_TICKS.map((hoursAgo) => {
          const slot = SLOTS - 1 - hoursAgo;
          return (
            <text key={hoursAgo} x={xOfSlot(slot)} y={VB_H - 4}
              textAnchor="middle" fontSize={11} fill="#7a90a8">
              {hoursAgo}h
            </text>
          );
        })}
      </svg>
      {hover && (
        <div
          className={styles.tooltip}
          style={{
            left: `${hover.xPct}%`,
            top:  `${hover.yPct}%`,
          }}
        >
          <span className={styles.tooltipValue}>{hover.value.toLocaleString()}</span>
          <span className={styles.tooltipWhen}>{hoursAgoLabel(t, SLOTS - 1 - slotOfIdx(hover.index))}</span>
        </div>
      )}
      </div>
    </div>
  );
}

function hoursAgoLabel(t: TFunction, h: number): string {
  if (h <= 0) return t('activity.thisHour');
  return t('time.hoursAgo', { value: h });
}

/** Chart identities, and the order they ship in. */
type ChartKey = 'jumps' | 'shipKills' | 'podKills' | 'npcKills' | 'npcDelta';
const DEFAULT_CHART_ORDER: ChartKey[] = ['jumps', 'shipKills', 'podKills', 'npcKills', 'npcDelta'];

function ActivityChartsView({ data }: { data: HourlyPoint[] }) {
  const { t } = useTranslation();
  // Per-chart visibility — defaults on, persisted cross-device via
  // users.ui_settings. Keys mirror the toggle labels in Map Options.
  const [showJumps]     = useUserSetting<boolean>('nexum.activity.showJumps',     true);
  const [showShipKills] = useUserSetting<boolean>('nexum.activity.showShipKills', true);
  const [showPodKills]  = useUserSetting<boolean>('nexum.activity.showPodKills',  true);
  const [showNpcKills]  = useUserSetting<boolean>('nexum.activity.showNpcKills',  true);
  const [showNpcDelta]  = useUserSetting<boolean>('nexum.activity.showNpcDelta',  true);

  // Reading order, persisted the same way. Drag a chart's grip to change it.
  const [savedOrder, setOrder] = useUserSetting<ChartKey[]>('nexum.activity.order', DEFAULT_CHART_ORDER);

  // NPC delta = each hour's NPC kill count minus the 24h mean. Positive
  // values mark hours of above-baseline rattering (ganking opportunity);
  // negative values mark unusually quiet hours. Same baseline approach
  // Dotlan uses on /map/<region>/<system>#npc_delta.
  const npcKills = data.map((p) => p.npcKills);
  const npcMean  = npcKills.length > 0 ? npcKills.reduce((s, v) => s + v, 0) / npcKills.length : 0;
  const npcDelta = npcKills.map((v) => v - npcMean);

  const charts: Record<ChartKey, { title: string; values: number[]; color: string; signed?: boolean; shown: boolean }> = {
    jumps:     { title: t('mapSidebar.activityJumps'),     values: data.map((p) => p.jumps),     color: '#4dd9ac', shown: showJumps },
    shipKills: { title: t('mapSidebar.activityShipKills'), values: data.map((p) => p.shipKills), color: '#e05a5a', shown: showShipKills },
    podKills:  { title: t('mapSidebar.activityPodKills'),  values: data.map((p) => p.podKills),  color: '#c084fc', shown: showPodKills },
    npcKills:  { title: t('mapSidebar.activityNpcKills'),  values: npcKills,                     color: '#5a9af8', shown: showNpcKills },
    npcDelta:  { title: t('mapSidebar.activityNpcDelta'),  values: npcDelta,                     color: '#f59e0b', shown: showNpcDelta, signed: true },
  };

  // A saved order can be stale in both directions: it may name a chart that no
  // longer exists, and it won't name one added since. Keep what we recognise,
  // then append anything new, so a later release's chart appears rather than
  // silently going missing.
  const order = useMemo(() => {
    const saved = Array.isArray(savedOrder) ? savedOrder : DEFAULT_CHART_ORDER;
    const known = saved.filter((k): k is ChartKey => DEFAULT_CHART_ORDER.includes(k as ChartKey));
    return [...known, ...DEFAULT_CHART_ORDER.filter((k) => !known.includes(k))];
  }, [savedOrder]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Reorder the full list, not just the visible slice, so hidden charts keep
    // their place for whenever they're switched back on.
    const from = order.indexOf(active.id as ChartKey);
    const to   = order.indexOf(over.id as ChartKey);
    if (from < 0 || to < 0) return;
    setOrder(arrayMove(order, from, to));
  }

  const visible = order.filter((k) => charts[k].shown);
  if (visible.length === 0) {
    return <div className="sig-pane__empty">{t('activity.allHidden')}</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      {/* Rect strategy, not the vertical one the panel stack uses: these wrap
          into a grid once the pane is wide enough for two across. */}
      <SortableContext items={visible} strategy={rectSortingStrategy}>
        <div className={styles.pane}>
          {visible.map((key) => (
            <MiniLineChart
              key={key}
              id={key}
              title={charts[key].title}
              values={charts[key].values}
              color={charts[key].color}
              signed={charts[key].signed}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export function ActivityPane({ eveSystemId }: { eveSystemId: number | null }) {
  const { t } = useTranslation();
  const [data, setData]       = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!eveSystemId) return;
    // Deliberate: clears this pane's own state when the record it shows changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData([]);
    setLoading(true);

    const load = () =>
      api<HourlyPoint[]>(`/api/activity/${eveSystemId}`)
        .then(setData)
        .catch(() => {});

    load().finally(() => setLoading(false));

    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [eveSystemId]);

  if (!eveSystemId) return <div className="sig-pane__empty">{t('panes.noEveSystem')}</div>;
  if (loading)      return <div className="sig-pane__empty">{t('activity.loading')}</div>;

  return <ActivityChartsView data={data} />;
}
