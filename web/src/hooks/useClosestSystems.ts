import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';

// Shared model for the "closest systems" list — the curated set of destinations
// (trade hubs + custom) the ClosestSystemsPane routes to, plus the auto-injected
// current home. Extracted so other views (e.g. a saved chain's exit distances)
// show the exact same list without the setting keys drifting.

export interface StoredEntry { id: number; name: string }

// EVE system IDs for the major trade hubs — the initial seed only; once the user
// edits the list, theirs wins.
export const CLOSEST_HUB_DEFAULTS: StoredEntry[] = [
  { id: 30000142, name: 'Jita'    },
  { id: 30002187, name: 'Amarr'   },
  { id: 30002510, name: 'Rens'    },
  { id: 30002659, name: 'Dodixie' },
  { id: 30002053, name: 'Hek'     },
];

export const CLOSEST_LIST_KEY        = 'nexum.closestSystems.list';
export const CLOSEST_HIDDEN_HOME_KEY = 'nexum.closestSystems.hiddenHome';

export function sanitiseClosestList(raw: unknown): StoredEntry[] {
  if (!Array.isArray(raw)) return CLOSEST_HUB_DEFAULTS;
  return raw
    .filter((e): e is StoredEntry =>
      typeof e === 'object' && e !== null
        && typeof (e as StoredEntry).id === 'number'
        && typeof (e as StoredEntry).name === 'string')
    .map((e) => ({ id: e.id, name: e.name }));
}

export interface ClosestEntry { id: number; name: string; isHome: boolean }

// The list as shown in the ClosestSystemsPane: the saved entries, with the
// current home system prepended when it isn't already listed and hasn't been
// hidden. Read-only — mutation stays in the pane.
export function useClosestSystemsList(): ClosestEntry[] {
  const [listRaw] = useUserSetting<StoredEntry[]>(CLOSEST_LIST_KEY, CLOSEST_HUB_DEFAULTS);
  const [hiddenHomeArr] = useUserSetting<number[]>(CLOSEST_HIDDEN_HOME_KEY, []);
  const homeSystem = useMapStore(useShallow((s) => {
    const found = s.map.systems.find((sys) => sys.isHome && sys.eveSystemId != null);
    return found ? { id: found.eveSystemId as number, name: found.name } : null;
  }));

  return useMemo(() => {
    const list = sanitiseClosestList(listRaw);
    const hiddenHome = new Set(hiddenHomeArr);
    const result: ClosestEntry[] = [];
    const seen = new Set<number>();
    for (const entry of list) {
      result.push({ id: entry.id, name: entry.name, isHome: homeSystem?.id === entry.id });
      seen.add(entry.id);
    }
    if (homeSystem && !seen.has(homeSystem.id) && !hiddenHome.has(homeSystem.id)) {
      result.unshift({ id: homeSystem.id, name: homeSystem.name, isHome: true });
    }
    return result;
  }, [listRaw, hiddenHomeArr, homeSystem]);
}
