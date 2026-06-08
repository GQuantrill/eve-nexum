import { useMemo } from 'react';
import { useUserSetting } from './useUserSetting';
import type { WatchEntry, WatchMatch, WatchMarkerKind } from '../types';

const SETTING_KEY = 'nexum.watchlist';

/** Cap on watchlist entries. A hand-maintained hunting list; past this the
 *  user wants notes/intel tags, not a watchlist. */
export const MAX_WATCH = 50;

const VALID_MARKERS: WatchMarkerKind[] = ['target', 'honeypot', 'avoid', 'friendly', 'watch'];

function isValidMatch(m: unknown): m is WatchMatch {
  if (m == null || typeof m !== 'object') return false;
  const by = (m as { by?: unknown }).by;
  switch (by) {
    case 'system':   return typeof (m as { query?: unknown }).query === 'string';
    case 'whType':   return typeof (m as { code?: unknown }).code === 'string';
    case 'class':    return typeof (m as { cls?: unknown }).cls === 'string';
    case 'effect':   return typeof (m as { effect?: unknown }).effect === 'string';
    case 'frigHole': return true;
    default:         return false;
  }
}

// Migrate the original watchlist shape ({ id, query, note, marker }) to the
// generalised one ({ id, match, note, marker }). Runs on every read; the new
// shape is written back the next time the user edits the list.
function coerce(v: unknown): WatchEntry | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.note !== 'string') return null;
  if (!VALID_MARKERS.includes(o.marker as WatchMarkerKind)) return null;
  let match: WatchMatch | null = null;
  if (isValidMatch(o.match)) match = o.match as WatchMatch;
  else if (typeof o.query === 'string') match = { by: 'system', query: o.query }; // legacy
  if (!match) return null;
  return { id: o.id, match, note: o.note, marker: o.marker as WatchMarkerKind };
}

export function useWatchlist(): [WatchEntry[], (next: WatchEntry[] | ((prev: WatchEntry[]) => WatchEntry[])) => void] {
  const [value, setValue] = useUserSetting<WatchEntry[]>(SETTING_KEY, []);
  // Defensive read: ui_settings JSONB could hold a malformed or legacy shape.
  // Memoised on `value` (which is referentially stable until the stored list
  // actually changes) so consumers — notably the alert hook, which compares
  // entry identity to decide when to reseed — get a stable array.
  const safe = useMemo(
    () => (Array.isArray(value) ? value.map(coerce).filter((e): e is WatchEntry => e !== null) : []),
    [value],
  );
  return [safe, setValue];
}
