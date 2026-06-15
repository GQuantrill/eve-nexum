import type { SystemClass, WormholeEffect } from '../types';

// CSS custom properties so the colour-vision palettes (--cv-class-* in
// App.css) can re-map system-class colours per colour-blindness mode.
export const CLASS_COLORS: Record<SystemClass, string> = {
  C1: 'var(--cv-class-c1)',
  C2: 'var(--cv-class-c2)',
  C3: 'var(--cv-class-c3)',
  C4: 'var(--cv-class-c4)',
  C5: 'var(--cv-class-c5)',
  C6: 'var(--cv-class-c6)',
  C13: 'var(--cv-class-c13)',
  HS: 'var(--cv-class-hs)',
  LS: 'var(--cv-class-ls)',
  NS: 'var(--cv-class-ns)',
  Thera: 'var(--cv-class-thera)',
  Pochven: 'var(--cv-class-pochven)',
  Drifter: 'var(--cv-class-drifter)',
};

export const CLASS_LABELS: Record<SystemClass, string> = {
  C1: 'C1', C2: 'C2', C3: 'C3', C4: 'C4', C5: 'C5', C6: 'C6', C13: 'C13',
  HS: 'Hi-Sec', LS: 'Low-Sec', NS: 'Null-Sec',
  Thera: 'Thera', Pochven: 'Pochven', Drifter: 'Drifter',
};

export const EFFECT_LABELS: Record<WormholeEffect, string> = {
  none: '',
  pulsar: 'Pulsar',
  black_hole: 'Black Hole',
  cataclysmic_variable: 'Cataclysmic',
  magnetar: 'Magnetar',
  red_giant: 'Red Giant',
  wolf_rayet: 'Wolf-Rayet',
};

// Wormhole type code → destination class
export const WORMHOLE_DESTINATIONS: Record<string, SystemClass> = {
  // → C1
  P060: 'C1', Q317: 'C1', Y790: 'C1', Z647: 'C1', Z971: 'C1',
  // → C2
  D364: 'C2', D382: 'C2', G024: 'C2', N766: 'C2',
  // → C3
  C247: 'C3', L477: 'C3', M267: 'C3', O477: 'C3',
  // → C4
  E175: 'C4', X877: 'C4', Y683: 'C4', Z457: 'C4',
  // → C5
  H296: 'C5', H900: 'C5', N062: 'C5', V911: 'C5',
  // → C6
  R474: 'C6', U574: 'C6', V753: 'C6', W237: 'C6',
  // → Hi-Sec
  B274: 'HS', D845: 'HS', N110: 'HS', Q063: 'HS',
  // → Low-Sec
  A239: 'LS', J244: 'LS', N432: 'LS', U210: 'LS', V898: 'LS',
  // → Null-Sec
  E545: 'NS', E587: 'NS', K346: 'NS', S047: 'NS', Z060: 'NS',
  // → Thera
  F135: 'Thera', F353: 'Thera', L031: 'Thera', M164: 'Thera', T458: 'Thera',
  // → C13 (shattered)
  A009: 'C13',
  // → Drifter
  B735: 'Drifter', C414: 'Drifter', R259: 'Drifter', S877: 'Drifter', V928: 'Drifter',
  // → frigate-only
  E004: 'C1', L005: 'C2', Z006: 'C3', M001: 'C4', C008: 'C5', G008: 'C6', Q003: 'NS',
};

// Grouped WH types for the picker UI (ordered for display)
export const WH_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: 'k162',    label: 'K162',     types: ['K162'] },
  { key: 'frigate', label: 'Frigate',  types: ['E004', 'L005', 'Z006', 'M001', 'C008', 'G008', 'Q003', 'A009'] },
  { key: 'highsec', label: 'Hi-Sec',   types: ['B274', 'D845', 'N110', 'Q063'] },
  { key: 'lowsec',  label: 'Low-Sec',  types: ['A239', 'J244', 'N432', 'U210', 'V898'] },
  { key: 'nullsec', label: 'Null-Sec', types: ['E545', 'E587', 'K346', 'S047', 'Z060'] },
  { key: 'c1',      label: 'Class 1',  types: ['E004', 'P060', 'Q317', 'Y790', 'Z647', 'Z971'] },
  { key: 'c2',      label: 'Class 2',  types: ['D364', 'D382', 'G024', 'L005', 'N766'] },
  { key: 'c3',      label: 'Class 3',  types: ['C247', 'L477', 'M267', 'O477', 'Z006'] },
  { key: 'c4',      label: 'Class 4',  types: ['E175', 'M001', 'X877', 'Y683', 'Z457'] },
  { key: 'c5',      label: 'Class 5',  types: ['C008', 'H296', 'H900', 'N062', 'V911'] },
  { key: 'c6',      label: 'Class 6',  types: ['G008', 'R474', 'U574', 'V753', 'W237'] },
  { key: 'thera',   label: 'Thera',    types: ['F135', 'F353', 'L031', 'M164', 'T458'] },
  { key: 'drifter', label: 'Drifter',  types: ['B735', 'C414', 'R259', 'S877', 'V928'] },
];

export const WORMHOLE_TYPES: Record<string, { leadsTo: SystemClass; maxMassKg: number; jumpMassKg: number; lifetimeH: number }> = {
  K162:  { leadsTo: 'C1', maxMassKg: 0,          jumpMassKg: 0,         lifetimeH: 24 },
  Z060:  { leadsTo: 'HS', maxMassKg: 500_000_000,  jumpMassKg: 20_000_000, lifetimeH: 16 },
  B274:  { leadsTo: 'HS', maxMassKg: 2_000_000_000, jumpMassKg: 300_000_000, lifetimeH: 24 },
  N110:  { leadsTo: 'C1', maxMassKg: 500_000_000,  jumpMassKg: 20_000_000, lifetimeH: 16 },
  C247:  { leadsTo: 'C3', maxMassKg: 1_800_000_000, jumpMassKg: 300_000_000, lifetimeH: 16 },
  X877:  { leadsTo: 'C4', maxMassKg: 2_000_000_000, jumpMassKg: 300_000_000, lifetimeH: 16 },
  D382:  { leadsTo: 'C5', maxMassKg: 3_000_000_000, jumpMassKg: 1_000_000_000, lifetimeH: 16 },
  W237:  { leadsTo: 'C6', maxMassKg: 3_000_000_000, jumpMassKg: 1_000_000_000, lifetimeH: 24 },
  S047:  { leadsTo: 'NS', maxMassKg: 2_000_000_000, jumpMassKg: 300_000_000, lifetimeH: 16 },
  N432:  { leadsTo: 'LS', maxMassKg: 2_000_000_000, jumpMassKg: 300_000_000, lifetimeH: 16 },
};

export const SYSTEM_CLASSES: SystemClass[] = [
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13',
  'HS', 'LS', 'NS', 'Thera', 'Pochven', 'Drifter',
];

export const WORMHOLE_EFFECTS: WormholeEffect[] = [
  'none', 'pulsar', 'black_hole', 'cataclysmic_variable', 'magnetar', 'red_giant', 'wolf_rayet',
];

// Colours are CSS custom properties (--cv-effect-* in App.css) so they re-map
// per colour-vision mode; used in DOM inline styles, so var() resolves.
export const EFFECT_ICONS: Record<WormholeEffect, { symbol: string; color: string }> = {
  none:                 { symbol: '',  color: '' },
  pulsar:               { symbol: '⚡', color: 'var(--cv-effect-pulsar)' },
  black_hole:           { symbol: '◉', color: 'var(--cv-effect-blackhole)' },
  cataclysmic_variable: { symbol: '⟳', color: 'var(--cv-effect-cataclysmic)' },
  magnetar:             { symbol: '✦', color: 'var(--cv-effect-magnetar)' },
  red_giant:            { symbol: '★', color: 'var(--cv-effect-redgiant)' },
  wolf_rayet:           { symbol: '⚔', color: 'var(--cv-effect-wolfrayet)' },
};

export const EFFECT_MODIFIERS: Record<WormholeEffect, Array<{ label: string; good: boolean }>> = {
  none: [],
  pulsar: [
    { label: 'Shield HP',      good: true  },
    { label: 'Cap Recharge',   good: true  },
    { label: 'Armor HP',       good: false },
    { label: 'Cap Size',       good: false },
  ],
  black_hole: [
    { label: 'Ship Speed',         good: true  },
    { label: 'Missile Speed',      good: true  },
    { label: 'Stasis Web Str',     good: false },
    { label: 'Target Painter Str', good: false },
    { label: 'Explosion Radius',   good: false },
  ],
  cataclysmic_variable: [
    { label: 'Local Rep',    good: true  },
    { label: 'Cap Recharge', good: true  },
    { label: 'Remote Rep',   good: false },
    { label: 'Cap Size',     good: false },
  ],
  magnetar: [
    { label: 'Drone Damage',      good: true  },
    { label: 'Targeting Range',   good: false },
    { label: 'Drone Range',       good: false },
    { label: 'Explosion Radius',  good: false },
  ],
  red_giant: [
    { label: 'Overheat Bonus',  good: true  },
    { label: 'Smartbomb Range', good: true  },
    { label: 'Heat Damage',     good: false },
  ],
  wolf_rayet: [
    { label: 'Small Weapons',    good: true  },
    { label: 'Armor HP',         good: true  },
    { label: 'Sig Radius',       good: true  },
    { label: 'Shield HP',        good: false },
  ],
};
