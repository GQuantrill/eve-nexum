import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../../api/client';
import { useUserSetting } from '../../hooks/useUserSetting';
import { normaliseSeries, peakOf } from '../../utils/activitySeries';
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

/**
 * The plot itself: axes, line, per-point hover. Shared by the per-metric mini
 * charts and by the signed delta chart in combined mode, so the geometry has
 * one home.
 */
function LineChartPlot({ values, color, signed = false }: {
  values: number[];
  color:  string;
  /** When true, the y-axis is symmetric around 0 — negatives plot below a
   *  zero baseline instead of the usual average line. Used for delta-style
   *  series where the sign carries meaning. */
  signed?: boolean;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HoverState | null>(null);
  const n   = values.length;
  const avg = n > 0 ? values.reduce((s, v) => s + v, 0) / n : 0;

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

        {/* Crosshair on the hovered point */}
        {hover && (
          <line
            x1={xOfIdx(hover.index)} y1={PAD.top}
            x2={xOfIdx(hover.index)} y2={PAD.top + IH}
            stroke={color} strokeWidth={0.8} opacity={0.4}
            pointerEvents="none"
          />
        )}

        {/* Data line */}
        {n > 1 && (
          <polyline points={polyline} fill="none" stroke={color} strokeWidth={1.5} />
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
  );
}

function MiniLineChart({ id, title, values, color, signed = false }: {
  /** Sortable id — the chart key. Charts reorder by drag, so each needs one. */
  id:      string;
  title:   string;
  values:  number[];
  color:   string;
  signed?: boolean;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

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
      <LineChartPlot values={values} color={color} signed={signed} />
    </div>
  );
}

// ── Combined chart ────────────────────────────────────────────────────────────

const CVB_H = 150;                       // taller than a mini chart: one plot now
const CPAD  = { top: 10, right: 6, bottom: 22, left: 34 };
const CIW   = VB_W - CPAD.left - CPAD.right;
const CIH   = CVB_H - CPAD.top  - CPAD.bottom;

interface Series { key: string; title: string; color: string; values: number[] }

/**
 * Every unsigned series on one set of axes, each scaled to its own peak.
 *
 * Hover targets are a column per hour rather than a dot per point: with four
 * series that would be ~96 overlapping circles, and the useful question at an
 * hour is "what was everything doing", not "what was this one line doing".
 */
function CombinedChart({ series }: { series: Series[] }) {
  const { t } = useTranslation();
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);

  const n = series[0]?.values.length ?? 0;
  const xOfSlot = (slot: number) => CPAD.left + (slot / (SLOTS - 1)) * CIW;
  const xOfIdx  = (i: number) => xOfSlot(SLOTS - n + i);
  const yOf     = (frac: number) => CPAD.top + CIH - frac * CIH;

  const plotted = series.map((s) => ({
    ...s,
    peak: peakOf(s.values),
    points: normaliseSeries(s.values)
      .map((f, i) => `${xOfIdx(i).toFixed(1)},${yOf(f).toFixed(1)}`).join(' '),
  }));

  const hoverIdx = hoverSlot == null ? null : hoverSlot - (SLOTS - n);
  const hovered  = hoverIdx != null && hoverIdx >= 0 && hoverIdx < n ? hoverIdx : null;

  return (
    <div className={styles.combined}>
      <div className={styles.plot}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VB_W} ${CVB_H}`}
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverSlot(null)}
        >
          {/* Y grid, labelled as a share of each series' own peak -- never a
              count, because the lines no longer share a unit. */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={CPAD.left} y1={yOf(f)} x2={CPAD.left + CIW} y2={yOf(f)}
                stroke="#1a2535" strokeWidth={0.5} />
              <text x={CPAD.left - 3} y={yOf(f) + 3.5} textAnchor="end" fontSize={11} fill="#7a90a8">
                {f * 100}%
              </text>
            </g>
          ))}

          {/* Current-hour marker (right edge) */}
          <line x1={xOfSlot(SLOTS - 1)} y1={CPAD.top} x2={xOfSlot(SLOTS - 1)} y2={CPAD.top + CIH}
            stroke="#2e4060" strokeWidth={1} strokeDasharray="2 2" />

          {hovered != null && (
            <line x1={xOfIdx(hovered)} y1={CPAD.top} x2={xOfIdx(hovered)} y2={CPAD.top + CIH}
              stroke="#7a90a8" strokeWidth={0.8} opacity={0.5} pointerEvents="none" />
          )}

          {plotted.map((s) => (
            <polyline key={s.key} points={s.points} fill="none" stroke={s.color} strokeWidth={1.5} />
          ))}

          {/* Dots only on the hovered hour, so four lines stay legible. */}
          {hovered != null && plotted.map((s) => (
            <circle key={s.key} cx={xOfIdx(hovered)}
              cy={yOf(s.peak > 0 ? s.values[hovered] / s.peak : 0)}
              r={3} fill={s.color} stroke="#08090f" strokeWidth={0.8} pointerEvents="none" />
          ))}

          {/* One full-height hit column per hour. */}
          {Array.from({ length: n }, (_, i) => {
            const half = CIW / (SLOTS - 1) / 2;
            return (
              <rect key={`hit-${i}`} x={xOfIdx(i) - half} y={CPAD.top}
                width={half * 2} height={CIH} fill="transparent"
                onMouseEnter={() => setHoverSlot(SLOTS - n + i)} />
            );
          })}

          {X_TICKS.map((hoursAgo) => (
            <text key={hoursAgo} x={xOfSlot(SLOTS - 1 - hoursAgo)} y={CVB_H - 4}
              textAnchor="middle" fontSize={11} fill="#7a90a8">
              {hoursAgo}h
            </text>
          ))}
        </svg>

        {hovered != null && (
          <div
            className={styles.multiTooltip}
            style={{
              left: `${(xOfIdx(hovered) / VB_W) * 100}%`,
              // Flip to the left of the crosshair past the midpoint so the
              // tooltip never runs off the right edge of the pane.
              transform: xOfIdx(hovered) > VB_W / 2 ? 'translate(-100%, 0)' : undefined,
            }}
          >
            <div className={styles.tooltipWhen}>
              {hoursAgoLabel(t, SLOTS - 1 - (SLOTS - n + hovered))}
            </div>
            {plotted.map((s) => (
              <div key={s.key} className={styles.tooltipRow}>
                <span className={styles.swatch} style={{ background: s.color }} />
                <span className={styles.tooltipName}>{s.title}</span>
                <span className={styles.tooltipValue}>{s.values[hovered].toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The legend carries the real magnitudes the axis deliberately drops. */}
      <div className={styles.legend}>
        {plotted.map((s) => (
          <span key={s.key} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: s.color }} />
            {s.title}
            <span className={styles.legendPeak}>{t('activity.peak', { value: s.peak.toLocaleString() })}</span>
          </span>
        ))}
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

  // Opt-in: one set of axes instead of a chart each, to save vertical room.
  // Default off, so the pane is unchanged for anyone who does not ask for it.
  const [combined, setCombined] = useUserSetting<boolean>('nexum.activity.combined', false);

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

  // The same setting Map Options writes, surfaced where the charts are: this is
  // a layout choice you make while looking at them, and Map Options is three
  // clicks and a different panel away.
  const toolbar = (
    <label className={styles.toolbar}>
      <input
        type="checkbox"
        checked={combined}
        onChange={(e) => setCombined(e.target.checked)}
      />
      <span>{t('mapSidebar.activityCombined')}</span>
    </label>
  );

  // npcDelta is excluded from the shared axis on purpose. It is a signed
  // departure from a baseline, so its zero means something ("normal"), while
  // the combined axis runs 0..peak and its zero means "nothing happened".
  // Folding the two together would put a meaningful line at a meaningless
  // place, so the delta keeps its own chart below.
  const mergeable = visible.filter((k) => !charts[k].signed);

  // Below two series there is nothing to merge, and normalising a lone line
  // would trade real counts on the axis for nothing at all.
  if (combined && mergeable.length > 1) {
    const rest = visible.filter((k) => charts[k].signed);
    return (
      <>
      {toolbar}
      <div className={styles.pane}>
        <CombinedChart
          series={mergeable.map((k) => ({
            key: k, title: charts[k].title, color: charts[k].color, values: charts[k].values,
          }))}
        />
        {/* Still draggable, but on its own: one chart cannot be reordered. */}
        {rest.map((key) => (
          <div key={key} className={styles.soloChart}>
            <div className={styles.titleRow}>
              <div className={styles.title}>{charts[key].title}</div>
            </div>
            <LineChartPlot
              values={charts[key].values}
              color={charts[key].color}
              signed={charts[key].signed}
            />
          </div>
        ))}
      </div>
      </>
    );
  }

  return (
    <>
    {toolbar}
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
    </>
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
