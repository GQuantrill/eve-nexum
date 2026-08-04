// Upwell structure docking rules for the jump planner, from the in-game docking
// matrix. Three states per (ship, structure): DOCK (can dock), TETHER (can get
// under the shield but not dock), UNDOCK (can leave but not dock/tether). Only
// DOCK lets a ship use the structure as a real endpoint; TETHER is a softer
// "you can arrive safe but not dock" and UNDOCK is a hard no.
//
// It is NOT purely size-based — Azbel (L engineering), Tatara (L refinery) and
// Fortizar (L citadel) differ for the same ship — so it's a full matrix.
export type DockState = 'dock' | 'tether' | 'undock';

// Structure columns in the matrix. Medium groups Astrahus/Raitaru/Athanor.
// 'station' = NPC station: normal capitals (Dread/Carrier/FAX/Rorqual) dock,
// supers/titans can't. Note: NPC stations aren't a jump-planner endpoint source
// yet (our structures come from corp ESI + map tags, both Upwell-only), so this
// column is dormant until stations become pickable — the rule is here so it's
// right when they do.
type StructCol = 'medium' | 'azbel' | 'tatara' | 'fortizar' | 'station' | 'sotiyo' | 'keepstar';
// Ship rows. Black Ops is a battleship, so it docks everywhere like a freighter.
type ShipRow = 'freighter' | 'rorqual' | 'capital' | 'super';

// SDE structure type name -> matrix column.
const STRUCTURE_COLUMN: Record<string, StructCol> = {
  Astrahus: 'medium', Raitaru: 'medium', Athanor: 'medium',
  Azbel: 'azbel',
  Tatara: 'tatara',
  Fortizar: 'fortizar',
  "'Moreau' Fortizar": 'fortizar', "'Draccous' Fortizar": 'fortizar',
  "'Horizon' Fortizar": 'fortizar', "'Prometheus' Fortizar": 'fortizar',
  Sotiyo: 'sotiyo',
  Keepstar: 'keepstar',
};

// JUMP_CLASSES key -> matrix row.
const SHIP_ROW: Record<string, ShipRow> = {
  blops: 'freighter',    // Black Ops battleship — docks anywhere a subcap can
  jf: 'freighter',       // Freighters / Jump Freighters
  rorqual: 'rorqual',
  carrier: 'capital',    // Dreadnoughts / Carriers / FAX / Lancers
  super: 'super',        // Supercarriers / Titans
};

const MATRIX: Record<ShipRow, Record<StructCol, DockState>> = {
  freighter: { medium: 'dock',   azbel: 'dock',   tatara: 'dock',   fortizar: 'dock',   station: 'dock',   sotiyo: 'dock',   keepstar: 'dock' },
  rorqual:   { medium: 'tether', azbel: 'undock', tatara: 'dock',   fortizar: 'dock',   station: 'dock',   sotiyo: 'dock',   keepstar: 'dock' },
  capital:   { medium: 'tether', azbel: 'undock', tatara: 'tether', fortizar: 'dock',   station: 'dock',   sotiyo: 'dock',   keepstar: 'dock' },
  super:     { medium: 'tether', azbel: 'tether', tatara: 'tether', fortizar: 'tether', station: 'undock', sotiyo: 'undock', keepstar: 'dock' },
};

/**
 * Docking state for `shipClass` at a structure of `structureType`, or null when
 * the type is unknown (e.g. a map-tagged structure with no resolved type) — the
 * caller should stay silent rather than guess.
 */
export function dockState(shipClass: string, structureType: string | null | undefined): DockState | null {
  if (!structureType) return null;
  const col = STRUCTURE_COLUMN[structureType];
  if (!col) return null;
  const row = SHIP_ROW[shipClass] ?? 'capital';
  return MATRIX[row][col];
}
