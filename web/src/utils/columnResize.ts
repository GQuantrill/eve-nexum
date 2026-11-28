// Drag-resizing for the Signatures / Anomalies tables.
//
// One column (the "filler") has no set width and takes whatever room the pane
// has beyond the other columns. That keeps every other column exactly the
// width it was set to, so a drag starts from what is on screen. Before, every
// column had a width and the table stretched them all to fill the pane: a drag
// started from the smaller saved width, so the edge didn't move until the
// pointer had passed the stretch, which looked like the column was locked.

/** Which column a drag on `at`'s right edge resizes, and in which direction.
 *  Left of the filler a column grows with the pointer and the filler gives the
 *  room. From the filler rightwards the edge moves by resizing the next column
 *  the other way, as the table's right edge is fixed. null: the last column's
 *  edge can't move (its left edge, the previous column's, does that job). */
export function edgeTarget<K extends string>(
  cols: readonly K[],
  filler: K | null,
  at: K,
): { col: K; sign: 1 | -1 } | null {
  const i = cols.indexOf(at);
  if (i < 0) return null;
  const f = filler == null ? -1 : cols.indexOf(filler);
  if (f < 0 || i < f) return { col: at, sign: 1 };
  const next = cols[i + 1];
  return next ? { col: next, sign: -1 } : null;
}

/** Follow the pointer from a mousedown on a header's resize handle. `th` is
 *  the header of the column being resized; its drawn width is the start. */
export function dragColumn(
  e: React.MouseEvent,
  th: Element,
  sign: 1 | -1,
  onWidth: (px: number) => void,
  min = 40,
): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const start = th.getBoundingClientRect().width;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (ev: MouseEvent) => {
    onWidth(Math.max(min, Math.round(start + sign * (ev.clientX - startX))));
  };
  const onUp = () => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  // Released outside the window: end the drag rather than leave it attached.
  window.addEventListener('blur', onUp);
}
