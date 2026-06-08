import type { WatchEntry, WatchMatch, MapSystem, MapConnection } from '../types';

// Frigate-only wormhole type codes (the "frigate" group in wormholes.ts). A
// system whose static is one of these — or a connection of one of these types,
// or any connection the user has sized "small" — is a frig hole.
export const FRIG_WH_TYPES = new Set(['E004', 'L005', 'Z006', 'M001', 'C008', 'G008', 'Q003', 'A009']);

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Stable key for a match — used to dedupe entries and to light up the
 *  quick-add palette (an active characteristic = an entry with that key). */
export function matchKey(m: WatchMatch): string {
  switch (m.by) {
    case 'system':   return `system:${norm(m.query)}`;
    case 'whType':   return `whType:${m.code.trim().toUpperCase()}`;
    case 'class':    return `class:${m.cls}`;
    case 'effect':   return `effect:${m.effect}`;
    case 'frigHole': return 'frigHole';
  }
}

/** Does a system satisfy an entry? whType / frigHole match the system's statics
 *  AND its scanned wormhole-sig types (passed in from the map-wide index), so a
 *  freshly-scanned sig counts even before it's resolved into a connection. */
export function systemMatchesEntry(e: WatchEntry, sys: MapSystem, sigTypes?: string[]): boolean {
  const m = e.match;
  switch (m.by) {
    case 'system':   return m.query.trim() !== '' && norm(sys.name) === norm(m.query);
    case 'whType': {
      if (m.code.trim() === '') return false;
      const code = m.code.trim().toUpperCase();
      return sys.statics.some((s) => s.toUpperCase() === code)
        || (sigTypes?.some((s) => s.toUpperCase() === code) ?? false);
    }
    case 'class':    return sys.systemClass === m.cls;
    case 'effect':   return sys.effect === m.effect;
    case 'frigHole': return sys.statics.some((s) => FRIG_WH_TYPES.has(s.toUpperCase()))
        || (sigTypes?.some((s) => FRIG_WH_TYPES.has(s.toUpperCase())) ?? false);
  }
}

/** Does a connection satisfy an entry? Only the wormhole-flavoured matches
 *  apply to an edge; system/class/effect are node concepts. */
export function connectionMatchesEntry(e: WatchEntry, conn: MapConnection): boolean {
  const m = e.match;
  switch (m.by) {
    case 'whType':   return m.code.trim() !== '' && !!conn.type && conn.type.toUpperCase() === m.code.trim().toUpperCase();
    case 'frigHole': return conn.size === 'small' || (!!conn.type && FRIG_WH_TYPES.has(conn.type.toUpperCase()));
    default:         return false;
  }
}

/** First entry (list order) that matches this system, or null. */
export function matchSystem(entries: WatchEntry[], sys: MapSystem, sigTypes?: string[]): WatchEntry | null {
  for (const e of entries) if (systemMatchesEntry(e, sys, sigTypes)) return e;
  return null;
}

/** First entry (list order) that matches this connection, or null. */
export function matchConnection(entries: WatchEntry[], conn: MapConnection): WatchEntry | null {
  for (const e of entries) if (connectionMatchesEntry(e, conn)) return e;
  return null;
}
