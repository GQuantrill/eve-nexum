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
  H296: 'C5', H900: 'C5', N062: 'C5', N432: 'C5', V911: 'C5',
  // → C6
  R474: 'C6', U574: 'C6', V753: 'C6', W237: 'C6',
  // → Hi-Sec
  B274: 'HS', D845: 'HS', N110: 'HS', Q063: 'HS',
  // → Low-Sec
  A239: 'LS', J244: 'LS', U210: 'LS', V898: 'LS',
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

// System-effect modifiers, per the in-game "Effects" panel. `good` = beneficial
// (shown ▲ green) vs detrimental (▼ red). Verified against the live client;
// magnitudes scale by class but the set and direction are fixed per effect.
export const EFFECT_MODIFIERS: Record<WormholeEffect, Array<{ label: string; good: boolean }>> = {
  none: [],
  // Pulsar: shield buffed, armor punished; larger sig, faster cap, stronger neuts.
  pulsar: [
    { label: 'Shield HP',      good: true  },
    { label: 'Cap Recharge',   good: true  },
    { label: 'Neut/NOS Drain', good: true  },
    { label: 'Armor Resist',   good: false },
    { label: 'Sig Radius',     good: false },
  ],
  // Black Hole: speed, range and missiles up; agility and webs down.
  black_hole: [
    { label: 'Ship Velocity',      good: true  },
    { label: 'Targeting Range',    good: true  },
    { label: 'Missile Velocity',   good: true  },
    { label: 'Missle & Vorton Explosion Velocity', good: true  },
    { label: 'Ship Agility',       good: false },
    { label: 'Stasis Web Strength',     good: false },
  ],
  // Cataclysmic Variable: remote reps, shield transfer and cap buffed; local
  // reps, cap recharge and remote cap transfer punished.
  cataclysmic_variable: [
    { label: 'Remote Armor Rep & Shield Boost',   good: true  },
    { label: 'Cap Capacity',       good: true  },
    { label: 'Cap Recharge Rate',       good: false },
    { label: 'Remote Cap Transfer',         good: false },
    { label: 'Local Armor Rep & Shield Boost',    good: false },
  ],
  // Magnetar: huge raw damage and explosion radius up; tracking, range and
  // target painting down.
  magnetar: [
    { label: 'Weapon Damage',    good: true  },
    { label: 'Explosion Radius', good: true  },
    { label: 'Drone Tracking',   good: false },
    { label: 'Tracking Speed',   good: false },
    { label: 'Targeting Range',  good: false },
    { label: 'Target Painter',   good: false },
  ],
  // Red Giant: overheat, smartbomb and bomb buffs; modules take more heat damage.
  red_giant: [
    { label: 'Overheat',        good: true  },
    { label: 'Smartbomb Damage & Range',   good: true  },
    { label: 'Bomb Damage',     good: true  },
    { label: 'Heat Damage',     good: false },
  ],
  // Wolf-Rayet: armor and small weapons buffed, smaller sig; shield resists punished.
  wolf_rayet: [
    { label: 'Small Weapon Damage', good: true  },
    { label: 'Armor HP',      good: true  },
    { label: 'Sig Radius Reduction',    good: true  },
    { label: 'Shield Resists', good: false },
  ],
};
