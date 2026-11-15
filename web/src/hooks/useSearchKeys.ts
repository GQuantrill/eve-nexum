import { useState, type KeyboardEvent } from 'react';

/**
 * Keyboard picking for a search box's results list: Arrow Up/Down move the
 * highlight and Enter picks it, so a typed name doesn't need a click to land.
 *
 * The highlight starts on the result whose name is exactly what was typed (so
 * "Jita" + Enter is Jita even when ESI lists Jita's neighbours first), else on
 * the first result. Moving it only holds for the query it was moved on; typing
 * more starts over. Nothing is highlighted until something is typed, so Enter
 * in an empty box that lists everything doesn't pick the first entry.
 *
 * `isDisabled` marks rows that show but can't be picked (already on the map,
 * already on the list): the highlight never lands on them.
 */
export function useSearchKeys<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  onPick: (item: T) => void,
  isDisabled?: (item: T) => boolean,
): {
  active: number;
  setActive: (i: number) => void;
  /** Forget a moved highlight, for a list that reopens on the same query. */
  reset: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
} {
  const [moved, setMoved] = useState<{ query: string; index: number } | null>(null);
  const q = query.trim().toLowerCase();
  const ok = (i: number) => i >= 0 && i < items.length && !isDisabled?.(items[i]);
  const exact = items.findIndex((it, i) => ok(i) && nameOf(it).toLowerCase() === q);
  const first = items.findIndex((_, i) => ok(i));
  const active =
    moved && moved.query === query && ok(moved.index) ? moved.index
    : q === '' ? -1
    : exact >= 0 ? exact : first;

  // The next pickable row from `from` in direction `dir`, or `from` itself.
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (ok(i)) return i;
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (first < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMoved({ query, index: step(active, 1) }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMoved({ query, index: active < 0 ? first : step(active, -1) }); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); onPick(items[active]); }
  };

  return {
    active,
    setActive: (i) => { if (ok(i)) setMoved({ query, index: i }); },
    reset: () => setMoved(null),
    onKeyDown,
  };
}
