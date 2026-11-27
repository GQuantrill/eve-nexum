// The Closest Systems list, shared with Useful Systems (which can add to it).

// EVE system IDs for the major trade hubs. Used as the initial seed only —
// once the user has touched the list, theirs wins.
const DEFAULT_HUBS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 30000142, name: 'Jita'    },
  { id: 30002187, name: 'Amarr'   },
  { id: 30002510, name: 'Rens'    },
  { id: 30002659, name: 'Dodixie' },
  { id: 30002053, name: 'Hek'     },
];

// Persist both the order AND the resolved names so the pane can label
// custom systems without making an extra round-trip on every reload.
export const LIST_KEY = 'nexum.closestSystems.list';
// IDs the user has explicitly hidden when they were the current home.
// Lets someone keep their home set in-game without it cluttering this
// pane. If they later change home to a different system, the new home
// still auto-appears because its ID isn't in this set.
export const HIDDEN_HOME_KEY = 'nexum.closestSystems.hiddenHome';
// Whether distances may route through the wormhole chains of EVERY map the
// user can see, or only the active one. Defaults to true, which is how this
// pane has always behaved — the surprise is not the behaviour but that it was
// invisible, so the toggle exposes it rather than changing it.
export const ALL_MAPS_KEY = 'nexum.closestSystems.allMaps';

export interface StoredEntry { id: number; name: string }

export const HUB_DEFAULTS: StoredEntry[] = DEFAULT_HUBS.map((h) => ({ id: h.id, name: h.name }));

export function sanitiseList(raw: unknown): StoredEntry[] {
  if (!Array.isArray(raw)) return HUB_DEFAULTS;
  return raw
    .filter((e): e is StoredEntry =>
      typeof e === 'object' && e !== null
        && typeof (e as StoredEntry).id === 'number'
        && typeof (e as StoredEntry).name === 'string')
    .map((e) => ({ id: e.id, name: e.name }));
}
