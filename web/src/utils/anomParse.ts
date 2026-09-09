import type { AnomType } from '../types';

/**
 * Probe-scanner paste parsing for cosmic anomalies.
 *
 * Lives outside AnomalyPane so it can be tested directly, and so the component
 * file goes back to exporting only components (react-refresh wants that).
 */

// The scanner tags every row with a group ("Cosmic Anomaly" for anoms, "Cosmic
// Signature" for sigs), so a single Ctrl+A / Ctrl+C of the whole window can be
// routed by group: the anomaly pane takes these, the signature pane takes the
// rest.
export const ANOM_GROUP = 'cosmic anomaly';

// Scanner "type" column → our enum. Ice belts also report as Ore Sites; only
// the name differs.
const EVE_ANOM_TYPE: Record<string, AnomType> = {
  'combat site':          'combat',
  'ore site':             'ore',
  'homefront operations': 'homefront',
};

// Homefront sites, matched on the site NAME because their scanner type column
// does not resolve to anything in the map above — they were arriving as
// "Unknown". Two intakes: the original three, and the five-player operations
// added in 2023.
const HOMEFRONT_NAMES = new Set([
  // 3-player operations
  'salvage research',
  'stabilize rift',
  'traffic stop',
  // 5-player operations
  'abyssal artifact recovery',
  'dread assault',
  'emergency aid',
  'metaliminal meteoroid',
  'raid',
  'suspicious signal',
]);

/**
 * Scanner type + site name → our enum.
 *
 * Ordered most specific first: an exact type match, then any type carrying the
 * word "homefront" (so a wording change doesn't silently produce Unknowns
 * again), then the known site names.
 */
export function classifyAnom(type: string, name: string): AnomType {
  const exact = EVE_ANOM_TYPE[type];
  if (exact) return exact;
  if (type.includes('homefront')) return 'homefront';
  if (HOMEFRONT_NAMES.has(name.trim().toLowerCase())) return 'homefront';
  return 'unknown';
}

export interface ParsedAnom { anomId: string; anomType: AnomType; name: string }

export function parseAnomClipboard(text: string): ParsedAnom[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedAnom[] => {
      const parts = line.split('\t');
      const anomId = parts[0]?.trim().toUpperCase() ?? '';
      if (!/^[A-Z]{3}-\d{3}$/.test(anomId)) return [];
      // Only rows the scanner classes as a Cosmic Anomaly — signatures are left
      // for the signature pane.
      if ((parts[1]?.trim().toLowerCase() ?? '') !== ANOM_GROUP) return [];
      const type = parts[2]?.trim().toLowerCase() ?? '';
      const col3 = parts[3]?.trim() ?? '';
      // Column 3 is the site name, unless the row is short enough that the
      // signal strength has slid into it.
      const name = /^\d+\.?\d*%$/.test(col3) ? '' : col3;
      return [{ anomId, anomType: classifyAnom(type, name), name }];
    });
}
