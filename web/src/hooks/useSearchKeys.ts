import { useState, type KeyboardEvent } from 'react';

/**
 * Keyboard picking for a search box's results list: Arrow Up/Down move the
 * highlight and Enter picks it, so a typed name doesn't need a click to land.
 *
 * The highlight starts on the result whose name is exactly what was typed (so
 * "Jita" + Enter is Jita even when ESI lists Jita's neighbours first), else on
 * the first result. Moving it only holds for the query it was moved on; typing
 * more starts over.
 */
export function useSearchKeys<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  onPick: (item: T) => void,
): { active: number; setActive: (i: number) => void; onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void } {
  const [moved, setMoved] = useState<{ query: string; index: number } | null>(null);
  const q = query.trim().toLowerCase();
  const exact = items.findIndex((it) => nameOf(it).toLowerCase() === q);
  const active = items.length === 0 ? -1
    : moved && moved.query === query ? Math.min(moved.index, items.length - 1)
    : Math.max(exact, 0);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (active < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMoved({ query, index: Math.min(active + 1, items.length - 1) }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMoved({ query, index: Math.max(active - 1, 0) }); }
    else if (e.key === 'Enter') { e.preventDefault(); onPick(items[active]); }
  };

  return { active, setActive: (i) => setMoved({ query, index: i }), onKeyDown };
}
