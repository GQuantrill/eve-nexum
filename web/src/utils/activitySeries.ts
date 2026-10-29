// Shared-axis maths for the combined activity chart.
//
// The problem this solves: the activity series differ by orders of magnitude.
// Jita runs ~3,400 jumps an hour against ~19 pod kills. Plotted on one absolute
// axis the kill series are a flat line along the floor -- a merged chart would
// be LESS readable than five separate ones, which defeats the point.
//
// So each series is scaled against its own 24h peak and the axis is labelled as
// a percentage of that peak, never as a count. That keeps the one thing a
// combined view is actually for -- comparing SHAPE, "did kills spike when
// traffic did?" -- while the real numbers stay in the tooltip and legend, where
// they cannot be misread off a gridline.

/** A series' peak, or 0 when it is empty or entirely zero. */
export function peakOf(values: number[]): number {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return max;
}

/**
 * Values as a 0..1 fraction of the series' own peak.
 *
 * An all-zero series (a quiet system's kills) flattens to 0 rather than
 * dividing by zero -- it genuinely has no shape to show, and plotting it along
 * the bottom is the honest rendering.
 */
export function normaliseSeries(values: number[]): number[] {
  const max = peakOf(values);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

// ── Placing points by their hour ─────────────────────────────────────────────

const HOUR_MS = 3_600_000;

export interface HourlyCounts {
  hour:      number;
  jumps:     number;
  shipKills: number;
  podKills:  number;
  npcKills:  number;
}

/**
 * Lay the server's hourly points out on the chart's 24-hour axis by their real
 * hour, instead of right-aligning them and calling the newest "this hour".
 *
 * CCP publishes each hour's jumps and kills some time into the NEXT hour, so the
 * newest point is normally last hour's, and `lag` says how many hours short of
 * now the series ends (the chart shifts left by that much). An hour with no row
 * inside the run is one with no activity -- the server only stores systems
 * that had some -- so it is filled with zeros rather than closed up, which used
 * to slide everything before it an hour to the right.
 */
export function alignHourly<T extends HourlyCounts>(
  points: T[], slots: number, now = Date.now(),
): { points: HourlyCounts[]; lag: number } {
  const current = now - (now % HOUR_MS);
  const oldest  = current - (slots - 1) * HOUR_MS;
  const inRange = points.filter((p) => p.hour >= oldest && p.hour <= current);
  if (inRange.length === 0) return { points: [], lag: 0 };
  const byHour = new Map(inRange.map((p) => [p.hour, p]));
  const first  = Math.min(...byHour.keys());
  const last   = Math.max(...byHour.keys());
  const out: HourlyCounts[] = [];
  for (let h = first; h <= last; h += HOUR_MS) {
    const p = byHour.get(h);
    out.push(p
      ? { hour: h, jumps: p.jumps, shipKills: p.shipKills, podKills: p.podKills, npcKills: p.npcKills }
      : { hour: h, jumps: 0, shipKills: 0, podKills: 0, npcKills: 0 });
  }
  return { points: out, lag: Math.round((current - last) / HOUR_MS) };
}
