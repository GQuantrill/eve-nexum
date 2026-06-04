import { useMemo } from 'react';
import { useUserSetting } from './useUserSetting';
import type { WatchEntry, WatchMarkerKind } from '../types';

const SETTING_KEY = 'nexum.watchlist';

/** Cap on watchlist entries. A hand-maintained hunting list; past this the
 *  user wants notes/intel tags, not a watchlist. */
export const MAX_WATCH = 50;

const VALID_MARKERS: WatchMarkerKind[] = ['target', 'honeypot', 'avoid', 'friendly', 'watch'];

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function useWatchlist(): [WatchEntry[], (next: WatchEntry[] | ((prev: WatchEntry[]) => WatchEntry[])) => void] {
  const [value, setValue] = useUserSetting<WatchEntry[]>(SETTING_KEY, []);
  // Defensive read: ui_settings JSONB could hold a malformed shape written by
  // a different client version. Keep only well-formed entries.
  const safe = Array.isArray(value)
    ? value.filter((v): v is WatchEntry =>
        v != null
        && typeof v === 'object'
        && typeof (v as WatchEntry).id === 'string'
        && typeof (v as WatchEntry).query === 'string'
        && typeof (v as WatchEntry).note === 'string'
        && VALID_MARKERS.includes((v as WatchEntry).marker))
    : [];
  return [safe, setValue];
}

/** Memoised name -> entry lookup. Built from the (normalised) query of each
 *  entry that has a non-empty query; first entry wins on a clash. System nodes
 *  use this to decide whether they're being watched without rescanning the
 *  whole list per node. */
export function useWatchIndex(): Map<string, WatchEntry> {
  const [items] = useWatchlist();
  return useMemo(() => {
    const m = new Map<string, WatchEntry>();
    for (const it of items) {
      const key = normalize(it.query);
      if (key && !m.has(key)) m.set(key, it);
    }
    return m;
  }, [items]);
}

/** The watch entry for a system name, if any. */
export function matchWatch(index: Map<string, WatchEntry>, name: string | undefined): WatchEntry | null {
  if (!name) return null;
  return index.get(normalize(name)) ?? null;
}
