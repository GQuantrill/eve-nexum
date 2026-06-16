// Maximum natural lifetime (hours) per wormhole type code. A wormhole cannot
// persist past this age — so once a sig's age exceeds it, the hole is gone.
//
// This is a server-side copy of the life_time column in
// web/src/data/whTypeChart.ts (the WH-type chart). Wormhole data changes at
// most once an expansion, so the duplication is low-maintenance; if the chart
// is regenerated, re-derive this table from it. Used by the lazy WH-removal
// sweep (services/whSweep.ts).
const WH_LIFETIME_HOURS: Record<string, number> = {
  A009: 4.5, A239: 24, A641: 16, A982: 24, B041: 48, B274: 24, B449: 16, B520: 48,
  B735: 16, C008: 4.5, C125: 16, C140: 24, C247: 16, C248: 24, C391: 48, C414: 16,
  C729: 12, D364: 16, D382: 16, D792: 24, D845: 24, E004: 4.5, E175: 16, E545: 16,
  E587: 16, F135: 16, F216: 12, F353: 16, G008: 4.5, G024: 16, H121: 16, H296: 24,
  H900: 24, I078: 4.5, I182: 16, J244: 24, J377: 24, J492: 24, K329: 16, K346: 16,
  L005: 4.5, L031: 16, L477: 16, L614: 24, L687: 4.5, M001: 4.5, M164: 16, M267: 16,
  M555: 24, M609: 16, N062: 24, N110: 24, N290: 24, N432: 24, N766: 16, N770: 24,
  N944: 24, N968: 16, O128: 24, O477: 16, O546: 4.5, O883: 16, P060: 16, Q003: 4.5,
  Q063: 16, Q317: 16, R051: 16, R081: 12, R259: 16, R474: 24, R943: 16, S047: 24,
  S199: 24, S804: 24, S877: 16, T405: 16, T458: 16, U210: 24, U319: 48, U372: 12,
  U574: 24, V283: 16, V301: 16, V753: 24, V898: 16, V911: 24, V928: 16, W237: 24,
  X450: 12, X702: 24, X877: 16, Y683: 16, Y790: 16, Z006: 4.5, Z060: 16, Z142: 16,
  Z457: 16, Z647: 16, Z971: 16,
};

// The longest lifetime any wormhole can have. K162 (the reverse side of a hole)
// carries no type-specific lifetime of its own — we can't know the originating
// hole's type — so it's aged against this conservative maximum.
export const MAX_WH_LIFETIME_HOURS = 48;

/**
 * Maximum lifetime in hours for a wormhole sig of the given type code, or
 * `null` if the code is unknown (in which case the sweep leaves it alone — we
 * never delete a hole whose lifetime we can't determine).
 *
 *  - K162: no inherent lifetime → the 48h max-possible-WH-life ceiling.
 *  - known code: its charted lifetime.
 *  - anything else (blank, junk, a future code we don't have): null.
 */
export function whLifetimeHours(code: string | null | undefined): number | null {
  if (!code) return null;
  const c = code.toUpperCase();
  if (c === 'K162') return MAX_WH_LIFETIME_HOURS;
  return WH_LIFETIME_HOURS[c] ?? null;
}
