import { useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { useStats, type StatPeriod, type SigBreakdown } from '../../hooks/useStats';

const SPARK_VB_W = 600;
const SPARK_VB_H = 80;
const SPARK_PAD  = { top: 6, right: 6, bottom: 18, left: 28 };
const SPARK_COLOR = '#6ea0ff';

function SigSparkline({ values }: { values: number[] }) {
  const n      = values.length;
  const iw     = SPARK_VB_W - SPARK_PAD.left - SPARK_PAD.right;
  const ih     = SPARK_VB_H - SPARK_PAD.top  - SPARK_PAD.bottom;
  const maxVal = Math.max(...values, 1);
  const xOf    = (i: number) => SPARK_PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yOf    = (v: number) => SPARK_PAD.top  + ih - (v / maxVal) * ih;

  const [hover, setHover] = useState<{ index: number; value: number } | null>(null);

  const polyline = values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const areaPath = n > 0
    ? `M${xOf(0).toFixed(1)},${(SPARK_PAD.top + ih).toFixed(1)} L${polyline} L${xOf(n - 1).toFixed(1)},${(SPARK_PAD.top + ih).toFixed(1)} Z`
    : '';

  // Y ticks: 0, mid, max
  const yTicks = [0, Math.round(maxVal / 2), maxVal];
  // X ticks: 30d ago (left) and today (right)
  const xLabels: { x: number; label: string }[] = n > 0 ? [
    { x: xOf(0),     label: `${n - 1}d ago` },
    { x: xOf(n - 1), label: 'today' },
  ] : [];

  return (
    <div className="stats-modal__spark">
      <svg
        className="stats-modal__spark-svg"
        viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid lines + Y labels */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={SPARK_PAD.left} y1={yOf(v)} x2={SPARK_PAD.left + iw} y2={yOf(v)}
              stroke="#1a2535" strokeWidth={0.5}
            />
            <text x={SPARK_PAD.left - 4} y={yOf(v) + 3} textAnchor="end" fontSize={10} fill="#7a90a8">
              {v}
            </text>
          </g>
        ))}

        {n > 0 && (
          <>
            <path d={areaPath} fill={SPARK_COLOR} opacity={0.12} />
            <polyline points={polyline} fill="none" stroke={SPARK_COLOR} strokeWidth={1.5} />
          </>
        )}

        {hover && (
          <line
            x1={xOf(hover.index)} y1={SPARK_PAD.top}
            x2={xOf(hover.index)} y2={SPARK_PAD.top + ih}
            stroke={SPARK_COLOR} strokeWidth={0.8} opacity={0.4}
          />
        )}

        {values.map((v, i) => {
          const cx = xOf(i);
          const cy = yOf(v);
          const isActive = hover?.index === i;
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={isActive ? 3 : 1.8}
                fill={SPARK_COLOR} stroke="#08090f" strokeWidth={0.6}
                pointerEvents="none" />
              <circle cx={cx} cy={cy} r={9}
                fill="transparent"
                onMouseEnter={() => setHover({ index: i, value: v })}
              />
            </g>
          );
        })}

        {xLabels.map((t) => (
          <text key={t.label} x={t.x} y={SPARK_VB_H - 4}
            textAnchor="middle" fontSize={10} fill="#7a90a8">
            {t.label}
          </text>
        ))}
      </svg>
      {hover && (
        <div className="stats-modal__spark-tooltip">
          <strong>{hover.value.toLocaleString()}</strong> sigs · {n - 1 - hover.index === 0 ? 'today' : `${n - 1 - hover.index}d ago`}
        </div>
      )}
    </div>
  );
}

const PERIODS: { key: StatPeriod; label: string }[] = [
  { key: 'day',     label: 'Today' },
  { key: 'week',    label: 'This Week' },
  { key: 'month',   label: 'This Month' },
  { key: 'year',    label: 'This Year' },
  { key: 'forever', label: 'All Time' },
];

const SIG_ROWS: { key: keyof SigBreakdown; label: string }[] = [
  { key: 'wormhole', label: 'Wormhole' },
  { key: 'data',     label: 'Data' },
  { key: 'relic',    label: 'Relic' },
  { key: 'gas',      label: 'Gas' },
  { key: 'ore',      label: 'Ore' },
  { key: 'combat',   label: 'Combat' },
];

interface Props { onClose: () => void; }

export function UserStatsModal({ onClose }: Props) {
  const [period, setPeriod] = useState<StatPeriod>('day');
  const { stats, loading, error } = useStats(true);

  const current = stats?.[period];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>

        <div className="modal__header">
          <h2 className="modal__title">User Stats</h2>
          <button className="modal__close" onClick={onClose}><XIcon size={14} weight="bold" /></button>
        </div>

        <div className="stats-modal__periods">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              className={`stats-modal__period-btn${period === p.key ? ' stats-modal__period-btn--active' : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="modal__body">
          {loading && <div className="stats-modal__loading">Loading…</div>}
          {error   && <div className="stats-modal__error">{error}</div>}

          {current && (
            <>
              <div className="stats-modal__summary">
                <div className="stats-modal__card">
                  <span className="stats-modal__card-value">{current.jumps.toLocaleString()}</span>
                  <span className="stats-modal__card-label">Jumps</span>
                </div>
                <div className="stats-modal__card">
                  <span className="stats-modal__card-value">{current.signatures.total.toLocaleString()}</span>
                  <span className="stats-modal__card-label">Signatures</span>
                </div>
              </div>

              {stats?.daily && stats.daily.some((v) => v > 0) && (
                <>
                  <h3 className="stats-modal__section-title">Daily activity — last 30 days</h3>
                  <SigSparkline values={stats.daily} />
                </>
              )}

              <h3 className="stats-modal__section-title">Signatures by type</h3>
              <table className="stats-modal__table">
                <thead>
                  <tr className="stats-modal__head-row">
                    <th className="stats-modal__th stats-modal__th--type">Type</th>
                    <th className="stats-modal__th stats-modal__th--count">Count</th>
                    <th className="stats-modal__th stats-modal__th--pct">%</th>
                    <th className="stats-modal__th stats-modal__th--bar" />
                  </tr>
                </thead>
                <tbody>
                  {SIG_ROWS.map((r) => {
                    const count = current.signatures[r.key];
                    const pct   = current.signatures.total > 0
                      ? Math.round((count / current.signatures.total) * 100)
                      : 0;
                    return (
                      <tr key={r.key} className="stats-modal__row">
                        <td className="stats-modal__row-label">{r.label}</td>
                        <td className="stats-modal__row-value">{count.toLocaleString()}</td>
                        <td className="stats-modal__row-pct">{pct}%</td>
                        <td className="stats-modal__row-bar">
                          <div className="stats-modal__bar-track">
                            <div className="stats-modal__bar" style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
