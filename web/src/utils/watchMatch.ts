import type { WatchEntry, WatchMatch, MapSystem, MapConnection, SystemClass } from '../types';
import { WORMHOLE_DESTINATIONS } from '../data/wormholes';
import { DEST_TO_CLASS } from './whDest';

// Frigate-only wormhole type codes (the "frigate" group in wormholes.ts). A
// system whose static is one of these — or a connection of one of these types,
// or any connection the user has sized "small" — is a frig hole.
export const FRIG_WH_TYPES = new Set(['E004', 'L005', 'Z006', 'M001', 'C008', 'G008', 'Q003', 'A009']);

// A scanned sig's "leads to" can be a band (unresolved to an exact class) rather
// than a single class. Expand a band to the classes it covers so a "leads to"
// watch still fires (a C1-C3 band could be your watched C2).
const BAND_CLASSES: Record<string, SystemClass[]> = {
  'C1-C3': ['C1', 'C2', 'C3'],
  'C4-C5': ['C4', 'C5'],
};

// The one wormhole-sig field the "leads to" watch reads: its type code and its
// recorded leads-to. Structural so any {whType, leadsTo} (the store's WhSig) fits.
export interface LeadsToSig { whType?: string; leadsTo?: string }

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// Classes a scanned sig's leads-to TOKEN represents (an exact class like "HS"
// or a band like "C1-C3"); empty for a pinned system name / unknown / "".
function leadsToTokenClasses(token: string | undefined): SystemClass[] {
  const up = (token ?? '').trim().toUpperCase();
  if (!up) return [];
  if (BAND_CLASSES[up]) return BAND_CLASSES[up];
  const cls = DEST_TO_CLASS[up.toLowerCase()];
  return cls ? [cls] : [];
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

/** Does a system satisfy an entry? whType / frigHole match the system's statics
 *  AND its scanned wormhole-sig types (passed in from the map-wide index), so a
 *  freshly-scanned sig counts even before it's resolved into a connection. */
export function systemMatchesEntry(
  e: WatchEntry,
  sys: MapSystem,
  sigTypes?: string[],
  whSigs?: LeadsToSig[],
  nameToClass?: Map<string, SystemClass>,
): boolean {
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
    case 'leadsTo': {
      // A wormhole whose DESTINATION is the watched class. Resolve each hole three
      // ways so anything we know the destination of counts:
      //   1. a fixed-destination code (statics + scanned sigs, e.g. a C2 static),
      //   2. a scanned sig's recorded leads-to TOKEN (K162 marked "Hi-Sec"/"C1-C3"),
      //   3. a scanned sig pinned to a specific SYSTEM (K162 solved to "Arnon") —
      //      resolved to that system's class via the name->class map.
      const codeLeads = (code: string) => WORMHOLE_DESTINATIONS[code.trim().toUpperCase()] === m.cls;
      if (sys.statics.some(codeLeads)) return true;
      return (whSigs ?? []).some((s) => {
        if (codeLeads(s.whType ?? '')) return true;
        if (leadsToTokenClasses(s.leadsTo).includes(m.cls)) return true;
        const pinned = (s.leadsTo ?? '').trim();
        return pinned !== '' && nameToClass?.get(pinned.toUpperCase()) === m.cls;
      });
    }
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
    case 'leadsTo':  return !!conn.type && WORMHOLE_DESTINATIONS[conn.type.trim().toUpperCase()] === m.cls;
    case 'frigHole': return conn.size === 'small' || (!!conn.type && FRIG_WH_TYPES.has(conn.type.toUpperCase()));
    default:         return false;
  }
}

/** First entry (list order) that matches this system, or null. */
export function matchSystem(
  entries: WatchEntry[],
  sys: MapSystem,
  sigTypes?: string[],
  whSigs?: LeadsToSig[],
  nameToClass?: Map<string, SystemClass>,
): WatchEntry | null {
  for (const e of entries) if (systemMatchesEntry(e, sys, sigTypes, whSigs, nameToClass)) return e;
  return null;
}

/** First entry (list order) that matches this connection, or null. */
export function matchConnection(entries: WatchEntry[], conn: MapConnection): WatchEntry | null {
  for (const e of entries) if (connectionMatchesEntry(e, conn)) return e;
  return null;
}
