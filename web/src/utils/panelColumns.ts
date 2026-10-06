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
