import type { WatchEntry, WatchMatch, MapSystem, MapConnection, SystemClass } from '../types';

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
    case 'leadsTo':  return `leadsTo:${m.cls}`;
    case 'effect':   return `effect:${m.effect}`;
    case 'frigHole': return 'frigHole';
  }
}

// The full condition list for an entry: its primary match plus any extra
// criteria. Combined per entry.criteriaMode ('or' = any, else 'and' = all).
function conditions(e: WatchEntry): WatchMatch[] {
  return e.criteria && e.criteria.length ? [e.match, ...e.criteria] : [e.match];
}
function combine(e: WatchEntry, test: (m: WatchMatch) => boolean): boolean {
  const conds = conditions(e);
  return e.criteriaMode === 'or' ? conds.some(test) : conds.every(test);
}

/** Does ONE condition hold for a system? whType / frigHole match the system's
 *  statics AND its scanned wormhole-sig types (passed in from the map-wide
 *  index), so a freshly-scanned sig counts even before it's resolved into a
 *  connection. leadsTo reads `destClasses` — the pre-resolved set of classes
 *  this system's wormholes (statics, scanned sigs and live connections) lead to,
 *  built once per map change by useLeadsToIndex. */
function systemMatchesOne(m: WatchMatch, sys: MapSystem, sigTypes?: string[], destClasses?: SystemClass[]): boolean {
  switch (m.by) {
    case 'system':   return m.query.trim() !== '' && norm(sys.name) === norm(m.query);
    case 'whType': {
      if (m.code.trim() === '') return false;
      const code = m.code.trim().toUpperCase();
      return sys.statics.some((s) => s.toUpperCase() === code)
        || (sigTypes?.some((s) => s.toUpperCase() === code) ?? false);
    }
    case 'class':    return sys.systemClass === m.cls;
    case 'leadsTo':  return (destClasses ?? []).includes(m.cls);
    case 'effect':   return sys.effect === m.effect;
    case 'frigHole': return sys.statics.some((s) => FRIG_WH_TYPES.has(s.toUpperCase()))
        || (sigTypes?.some((s) => FRIG_WH_TYPES.has(s.toUpperCase())) ?? false);
  }
}

/** Does a system satisfy an entry — its primary match combined with any criteria
 *  by the entry's AND/OR mode? */
export function systemMatchesEntry(e: WatchEntry, sys: MapSystem, sigTypes?: string[], destClasses?: SystemClass[]): boolean {
  return combine(e, (m) => systemMatchesOne(m, sys, sigTypes, destClasses));
}

/** Does ONE condition hold for a connection? Only the wormhole-flavoured matches
 *  apply to an edge; system/class/effect/leadsTo are node concepts, so they're
 *  false here — which makes a compound entry with a node-only criterion light up
 *  connections only in OR mode (never in AND, since a node condition can't hold
 *  on a bare edge). */
function connMatchesOne(m: WatchMatch, conn: MapConnection): boolean {
  switch (m.by) {
    case 'whType':   return m.code.trim() !== '' && !!conn.type && conn.type.toUpperCase() === m.code.trim().toUpperCase();
    case 'frigHole': return conn.size === 'small' || (!!conn.type && FRIG_WH_TYPES.has(conn.type.toUpperCase()));
    default:         return false;
  }
}

/** Does a connection satisfy an entry (primary + criteria, combined by mode)? */
export function connectionMatchesEntry(e: WatchEntry, conn: MapConnection): boolean {
  return combine(e, (m) => connMatchesOne(m, conn));
}

/** First entry (list order) that matches this system, or null. */
export function matchSystem(entries: WatchEntry[], sys: MapSystem, sigTypes?: string[], destClasses?: SystemClass[]): WatchEntry | null {
  for (const e of entries) if (systemMatchesEntry(e, sys, sigTypes, destClasses)) return e;
  return null;
}

/** First entry (list order) that matches this connection, or null. */
export function matchConnection(entries: WatchEntry[], conn: MapConnection): WatchEntry | null {
  for (const e of entries) if (connectionMatchesEntry(e, conn)) return e;
  return null;
}
