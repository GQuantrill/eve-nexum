import { useState, type KeyboardEvent } from 'react';

// The highlighted row's class in each list that uses this hook. Only one
// dropdown is open at a time, so after an arrow press the highlighted row is
// found by class and scrolled into view -- a long list (wormhole types) would
// otherwise move the highlight out of sight.
const ACTIVE_ROW = '.search-results__item--active, .scout-pane__add-result--active, .wh-picker__option--kbd';
const revealActive = () => requestAnimationFrame(() =>
  document.querySelector<HTMLElement>(ACTIVE_ROW)?.scrollIntoView({ block: 'nearest' }));

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
 *
 * `startAt` is where the highlight sits before anything is typed -- a picker
 * that opens on its current value starts there, like a native select.
 */
export function useSearchKeys<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  onPick: (item: T) => void,
  isDisabled?: (item: T) => boolean,
  startAt = -1,
): {
  active: number;
  setActive: (i: number) => void;
  /** Forget a moved highlight, for a list that reopens on the same query. */
  reset: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
} {
  const [moved, setMoved] = useState<{ query: string; index: number } | null>(null);
  const q = query.trim().toLowerCase();
  const ok = (i: number) => i >= 0 && i < items.length && !isDisabled?.(items[i]);
  const exact = items.findIndex((it, i) => ok(i) && nameOf(it).toLowerCase() === q);
  const first = items.findIndex((_, i) => ok(i));
  const active =
    moved && moved.query === query && ok(moved.index) ? moved.index
    : q === '' ? (ok(startAt) ? startAt : -1)
    : exact >= 0 ? exact : first;

  // The next pickable row from `from` in direction `dir`, or `from` itself.
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (ok(i)) return i;
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (first < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMoved({ query, index: step(active, 1) }); revealActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMoved({ query, index: active < 0 ? first : step(active, -1) }); revealActive(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); onPick(items[active]); }
  };

  return {
    active,
    setActive: (i) => { if (ok(i)) setMoved({ query, index: i }); },
    reset: () => setMoved(null),
    onKeyDown,
  };
}

