// Upwell structure docking rules for the jump planner. A ship can dock when its
// category (subcap / capital / supercapital) is within the structure's maximum.
// Black Ops are battleships, so they dock anywhere a subcap can. Regular capitals
// need a Large+ structure; supers/titans dock ONLY at an XL citadel (Keepstar) —
// not XL engineering (Sotiyo).
//
// VERIFY THESE against EVE before relying on them (same footing as the fuel
// numbers) — the structure -> max-category table is the bit most likely to drift.
export type DockCategory = 'subcap' | 'capital' | 'supercapital';
const ORDER: Record<DockCategory, number> = { subcap: 0, capital: 1, supercapital: 2 };

// JUMP_CLASSES key -> the category that has to dock.
const SHIP_CATEGORY: Record<string, DockCategory> = {
  blops: 'subcap',        // Black Ops is a battleship, not a capital
  jf: 'capital',
  rorqual: 'capital',
  carrier: 'capital',     // Carrier / Dread / FAX
  super: 'supercapital',  // Super / Titan
};

// Structure type name (from the SDE) -> the highest category it can dock.
const STRUCTURE_MAX: Record<string, DockCategory> = {
  // Medium — subcaps (and Black Ops) only
  Astrahus: 'subcap', Raitaru: 'subcap', Athanor: 'subcap',
  // Large — capitals
  Fortizar: 'capital', Azbel: 'capital', Tatara: 'capital',
  "'Moreau' Fortizar": 'capital', "'Draccous' Fortizar": 'capital',
  "'Horizon' Fortizar": 'capital', "'Prometheus' Fortizar": 'capital',
  // XL citadel — supers / titans
  Keepstar: 'supercapital',
  // XL engineering — capitals, but NOT supers / titans
  Sotiyo: 'capital',
};

/**
 * Can `shipClass` dock at a structure of `structureType`? Returns null when the
 * type is unknown (e.g. a map-tagged structure with no resolved type) — the
 * caller should stay silent rather than warn on a guess.
 */
export function canDock(shipClass: string, structureType: string | null | undefined): boolean | null {
  if (!structureType) return null;
  const max = STRUCTURE_MAX[structureType];
  if (max == null) return null;
  const need = SHIP_CATEGORY[shipClass] ?? 'capital';
  return ORDER[need] <= ORDER[max];
}
