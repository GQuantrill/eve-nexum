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
