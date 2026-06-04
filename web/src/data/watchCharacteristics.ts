import type { WatchMatch, WatchMarkerKind, WormholeEffect } from '../types';
import { EFFECT_LABELS } from './wormholes';

// The quick-add palette: one chip per "general characteristic". Ticking a chip
// drops a matching row into the watchlist (with a default marker the user can
// then change); unticking removes any row with that match. Labels stay English
// constants — consistent with EFFECT_LABELS, which the rest of the app shows
// untranslated too.
export interface CharacteristicDef {
  key:           string;
  label:         string;
  match:         WatchMatch;
  defaultMarker: WatchMarkerKind;
}

const EFFECTS: WormholeEffect[] = ['wolf_rayet', 'pulsar', 'black_hole', 'magnetar', 'red_giant', 'cataclysmic_variable'];

export const WATCH_CHARACTERISTICS: CharacteristicDef[] = [
  { key: 'shattered', label: 'Shattered', match: { by: 'class', cls: 'C13' }, defaultMarker: 'watch' },
  ...EFFECTS.map((effect): CharacteristicDef => ({
    key: `effect:${effect}`,
    label: EFFECT_LABELS[effect],
    match: { by: 'effect', effect },
    defaultMarker: 'watch',
  })),
  { key: 'frigHole', label: 'Frig holes', match: { by: 'frigHole' }, defaultMarker: 'watch' },
];
