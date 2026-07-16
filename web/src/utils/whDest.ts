import type { SystemClass } from '../types';
import { CLASS_COLORS, CLASS_LABELS, WORMHOLE_DESTINATIONS } from '../data/wormholes';

// Single source of truth for "where does a wormhole lead / what colour is it".
// The authoritative data is the SDE-derived catalog served by
// /api/wormholes/types (loaded once via useWormholeTypes); the small hardcoded
// WORMHOLE_DESTINATIONS map is only a first-paint / offline fallback. Anything
// that needs a destination class MUST go through here so the whole app stays
// consistent (the hardcoded map has drifted from the SDE before — e.g. N432).

// Server's lowercase `dest` -> the SystemClass union used by CLASS_COLORS/LABELS.
export const DEST_TO_CLASS: Record<string, SystemClass> = {
  c1: 'C1', c2: 'C2', c3: 'C3', c4: 'C4', c5: 'C5', c6: 'C6', c13: 'C13',
  hs: 'HS', ls: 'LS', ns: 'NS',
  thera: 'Thera', pochven: 'Pochven', drifter: 'Drifter',
};

// Minimal shape of the useWormholeTypes() map that this module reads.
export type WhTypeDest = Record<string, { dest?: string } | undefined>;

/** A wormhole type code's destination class — SDE first, hardcoded fallback. */
export function whDestClass(code: string | null | undefined, types: WhTypeDest): SystemClass | null {
  if (!code) return null;
  const c = code.toUpperCase();
  const fromServer = types[c]?.dest;
  if (fromServer) return DEST_TO_CLASS[fromServer.toLowerCase()] ?? null;
  return WORMHOLE_DESTINATIONS[c] ?? null;
}

// leads-to tokens that are a class/band/unknown rather than a pinned system. A
// value NOT in here is a specific connected-system name — i.e. the hole is
// already solved. Case-insensitive so every consumer agrees (this set was
// previously duplicated in undivedWormholes + whJumpConfirm and had drifted in
// case-handling). Legacy exact C-classes included.
const UNRESOLVED_LEADS_TO = new Set([
  '', 'UNKNOWN',
  'C1-C3', 'C4-C5', 'C6', 'C13', 'THERA', 'POCHVEN', 'DRIFTER',
  'HS', 'LS', 'NS',
  'C1', 'C2', 'C3', 'C4', 'C5',
]);

/** True while a hole's leads-to is still a class/band/unknown (not pinned to a
 *  specific system). The single source for "is this hole unresolved". */
export function isUnresolvedLeadsTo(value: string | null | undefined): boolean {
  return UNRESOLVED_LEADS_TO.has((value ?? '').trim().toUpperCase());
}

// A leads-to band expands to the exact classes it covers, so a hole recorded as
// "C1-C3" counts toward a watch on any of C1/C2/C3.
const BAND_TO_CLASSES: Record<string, SystemClass[]> = {
  'C1-C3': ['C1', 'C2', 'C3'],
  'C4-C5': ['C4', 'C5'],
};

/** The concrete classes a leads-to TOKEN represents — an exact class ("HS", "C2")
 *  or a band ("C1-C3"); [] for a pinned system name / unknown / "". */
export function leadsToClasses(token: string | null | undefined): SystemClass[] {
  const up = (token ?? '').trim().toUpperCase();
  if (!up) return [];
  if (BAND_TO_CLASSES[up]) return BAND_TO_CLASSES[up];
  const cls = DEST_TO_CLASS[up.toLowerCase()];
  return cls ? [cls] : [];
}

// J-space "band" leads-to values (an unscanned hole reports a band, not an exact
// class) with display label + colour. Single source — the LeadsToDropdown picker
// builds its band options from this map, and holeDisplay resolves stored band
// values through it. Insertion order is the picker's display order. Each band is
// coloured by its worst class so the threat reads green -> orange -> red.
export const LEADS_TO_BANDS: Record<string, { label: string; color: string }> = {
  'C1-C3': { label: 'C1 - C3', color: CLASS_COLORS.C3 },
  'C4-C5': { label: 'C4 - C5', color: CLASS_COLORS.C5 },
};

/** Label + colour for a leads-to value (band or exact class); null when empty,
 *  unknown, or a free-form connected-system name. */
function leadsToDisplay(value: string | null | undefined): { label: string; color: string } | null {
  const v = (value ?? '').trim();
  if (!v || v.toLowerCase() === 'unknown') return null;
  const band = LEADS_TO_BANDS[v.toUpperCase()];
  if (band) return band;
  if (v in CLASS_LABELS) {
    const cls = v as SystemClass;
    return { label: CLASS_LABELS[cls], color: CLASS_COLORS[cls] };
  }
  return null;
}

/** Destination label + colour to display for an undived hole: the wormhole
 *  type's destination when known (single source), else its leads-to band/class. */
export function holeDisplay(
  code: string | null | undefined,
  leadsTo: string | null | undefined,
  types: WhTypeDest,
): { label: string; color: string } | null {
  const dc = whDestClass(code, types);
  if (dc) return { label: CLASS_LABELS[dc], color: CLASS_COLORS[dc] };
  return leadsToDisplay(leadsTo);
}
