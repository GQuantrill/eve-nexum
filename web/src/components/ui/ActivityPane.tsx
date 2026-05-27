import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUserSetting } from '../../hooks/useUserSetting';

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

function MiniLineChart({ title, values, color, signed = false }: {
  title:   string;
  values:  number[];
  color:   string;
  /** When true, the y-axis is symmetric around 0 — negatives plot below a
   *  zero baseline instead of the usual average line. Used for delta-style
   *  series where the sign carries meaning. */
  signed?: boolean;
}) {
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
    <div className="activity-chart">
      <div className="activity-chart__title">{title}</div>
      <div className="activity-chart__plot">
      <svg
        className="activity-chart__svg"
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
          className="activity-chart__tooltip"
          style={{
            left: `${hover.xPct}%`,
            top:  `${hover.yPct}%`,
          }}
        >
          <span className="activity-chart__tooltip-value">{hover.value.toLocaleString()}</span>
          <span className="activity-chart__tooltip-when">{hoursAgoLabel(SLOTS - 1 - slotOfIdx(hover.index))}</span>
        </div>
      )}
      </div>
    </div>
  );
}

function hoursAgoLabel(h: number): string {
  if (h <= 0) return 'this hour';
  if (h === 1) return '1h ago';
  return `${h}h ago`;
}

function ActivityChartsView({ data }: { data: HourlyPoint[] }) {
  // Per-chart visibility — defaults on, persisted cross-device via
  // users.ui_settings. Keys mirror the toggle labels in Map Options.
  const [showJumps]     = useUserSetting<boolean>('nexum.activity.showJumps',     true);
  const [showShipKills] = useUserSetting<boolean>('nexum.activity.showShipKills', true);
  const [showPodKills]  = useUserSetting<boolean>('nexum.activity.showPodKills',  true);
  const [showNpcKills]  = useUserSetting<boolean>('nexum.activity.showNpcKills',  true);
  const [showNpcDelta]  = useUserSetting<boolean>('nexum.activity.showNpcDelta',  true);

  // NPC delta = each hour's NPC kill count minus the 24h mean. Positive
  // values mark hours of above-baseline rattering (ganking opportunity);
  // negative values mark unusually quiet hours. Same baseline approach
  // Dotlan uses on /map/<region>/<system>#npc_delta.
  const npcKills = data.map((p) => p.npcKills);
  const npcMean  = npcKills.length > 0 ? npcKills.reduce((s, v) => s + v, 0) / npcKills.length : 0;
  const npcDelta = npcKills.map((v) => v - npcMean);

  const anyVisible = showJumps || showShipKills || showPodKills || showNpcKills || showNpcDelta;
  if (!anyVisible) {
    return <div className="sig-pane__empty">All charts hidden. Toggle them on in Map Options → Activity.</div>;
  }

  return (
    <div className="activity-pane">
      {showJumps && (
        <MiniLineChart
          title="Jumps"
          values={data.map((p) => p.jumps)}
          color="#4dd9ac"
        />
      )}
      {showShipKills && (
        <MiniLineChart
          title="Ship Kills"
          values={data.map((p) => p.shipKills)}
          color="#e05a5a"
        />
      )}
      {showPodKills && (
        <MiniLineChart
          title="Pod Kills"
          values={data.map((p) => p.podKills)}
          color="#c084fc"
        />
      )}
      {showNpcKills && (
        <MiniLineChart
          title="NPC Kills"
          values={data.map((p) => p.npcKills)}
          color="#5a9af8"
        />
      )}
      {showNpcDelta && (
        <MiniLineChart
          title="NPC Delta"
          values={npcDelta}
          color="#f59e0b"
          signed
        />
      )}
    </div>
  );
}

export function ActivityPane({ eveSystemId }: { eveSystemId: number | null }) {
  const [data, setData]       = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!eveSystemId) return;
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

  if (!eveSystemId) return <div className="sig-pane__empty">No EVE system linked</div>;
  if (loading)      return <div className="sig-pane__empty">Loading activity…</div>;

  return <ActivityChartsView data={data} />;
}
