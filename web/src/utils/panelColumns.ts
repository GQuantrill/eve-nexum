// Splitting the system panel's pane stack into parallel columns.
//
// The pure half of the feature, kept out of the component because this is where
// the mistakes live: losing a pane, or reordering one column and quietly
// scrambling another.
//
// Two pieces of state, deliberately separate:
//   panelOrder   the single global order, unchanged and still the only thing
//                persisted to users.panel_order. Within a column, panes appear
//                in this order.
//   columns      paneId -> column index. Absent means column 0.
//
// Keeping them apart means the column feature touches neither the panel_order
// wire format nor anything that reads it.

export const MAX_PANEL_COLUMNS = 3;

export type ColumnMap = Record<string, number>;

/** 1..MAX, with anything unparseable falling back to one column (today's layout). */
export function clampColumnCount(v: unknown): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PANEL_COLUMNS, Math.max(1, n));
}

/**
 * Which column a pane sits in, given the current count.
 *
 * Unknown panes land in column 0 — a pane added in a later release must appear
 * somewhere obvious rather than nowhere. Anything past the last column clamps
 * into it, so reducing the count folds those panes back into view instead of
 * hiding them.
 */
export function columnOf(id: string, columns: ColumnMap, count: number): number {
  const raw = columns[id];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.floor(raw), count - 1);
}

/** The docked panes bucketed into columns, each keeping its panelOrder order. */
export function bucketIntoColumns(ids: string[], columns: ColumnMap, count: number): string[][] {
  const out: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) out[columnOf(id, columns, count)].push(id);
  return out;
}

/** The column map with one pane moved, clamped to the available columns. */
export function movePane(columns: ColumnMap, id: string, to: number, count: number): ColumnMap {
  return { ...columns, [id]: Math.min(count - 1, Math.max(0, to)) };
}

/**
 * Apply a within-column reorder back onto the global order.
 *
 * The dragged pane and its target are both in one column, so only that column's
 * panes move. Their SLOTS in the global order are reused in place, which leaves
 * every other column's relative order exactly as it was — the alternative,
 * rebuilding the order column by column, would silently reshuffle the panes the
 * user never touched.
 *
 * Returns the order unchanged when either id is missing, so a stray drag event
 * cannot corrupt it.
 */
export function reorderWithinColumn(
  order: string[], columnIds: string[], activeId: string, overId: string,
): string[] {
  const from = columnIds.indexOf(activeId);
  const to   = columnIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return order;

  const moved = [...columnIds];
  moved.splice(to, 0, moved.splice(from, 1)[0]);

  const inColumn = new Set(columnIds);
  let next = 0;
  return order.map((id) => (inColumn.has(id) ? moved[next++] : id));
}

// ── Column widths ────────────────────────────────────────────────────────────
//
// Columns default to an equal share, which is wrong whenever the panes differ
// in size: a two-line killboard beside a stack of charts gets exactly as much
// width as the charts do.
//
// Widths are stored as WEIGHTS, not pixels. The panel itself is resizable and
// sits in a window that resizes too, so a pixel width would be correct only at
// the width it was set at. A weight keeps its share of whatever space exists.

/** Smallest share a column may be dragged to, as a fraction of the pair being
 *  resized. Stops a column being dragged to nothing and stranding its panes. */
const MIN_PAIR_FRACTION = 0.15;

/** Equal weights for `count` columns — the default, and the reset. */
export function equalWeights(count: number): number[] {
  return Array.from({ length: count }, () => 1);
}

/**
 * A stored weight list made safe for `count` columns.
 *
 * Stored lists go stale in both directions: the column count can change after
 * the widths were saved, and a hand-edited setting can contain anything. Short
 * lists are padded with equal weights, long ones truncated, and non-finite or
 * non-positive entries replaced -- a zero or NaN weight would collapse a column
 * to nothing with no way to drag it back.
 */
export function normaliseWeights(raw: unknown, count: number): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: count }, (_, i) => {
    const v = typeof list[i] === 'number' ? (list[i] as number) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
}

/**
 * Weights after dragging the divider between columns `left` and `right`.
 *
 * The two are NOT assumed adjacent. An empty column is not rendered, so a
 * divider can sit between columns 0 and 2 with 1 skipped; taking both indices
 * means the drag adjusts the columns either side of the handle rather than
 * whichever index happens to be next in the array.
 *
 * Only those two change: their combined weight is held constant, so every
 * other column keeps the width it had. Dragging one divider must not nudge a
 * column on the far side of the panel.
 *
 * `deltaPx` is the pointer's movement, `pairPx` the current on-screen width of
 * the two columns together. Returns the input unchanged when the geometry is
 * unusable (a zero-width container during first paint), so a stray event
 * cannot wipe the weights.
 */
export function resizeWeights(
  weights: number[], left: number, right: number, deltaPx: number, pairPx: number,
): number[] {
  if (!Number.isFinite(deltaPx) || pairPx <= 0) return weights;
  if (left < 0 || right < 0 || left >= weights.length || right >= weights.length) return weights;
  if (left === right) return weights;

  const pairWeight = weights[left] + weights[right];
  if (!(pairWeight > 0)) return weights;

  const leftPx = pairPx * (weights[left] / pairWeight);
  const min = pairPx * MIN_PAIR_FRACTION;
  const nextLeftPx = Math.min(Math.max(leftPx + deltaPx, min), pairPx - min);

  const next = [...weights];
  next[left]  = pairWeight * (nextLeftPx / pairPx);
  next[right] = pairWeight - next[left];
  return next;
}
