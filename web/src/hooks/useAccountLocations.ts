import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';
import { createPolledStore } from './createPolledStore';

export interface AccountCharLocation {
  charId:        number;
  characterId:   number;
  characterName: string;
  online:        boolean;        // false = position is from last known system
  eveSystemId:   number;
  systemName:    string | null;
  systemClass:   string | null;
}

export interface AccountLocations {
  /** solarSystemId → the account's characters currently shown there. */
  bySystem: Map<number, AccountCharLocation[]>;
  /** users.id → that character's location (for following a tracked character). */
  byChar:   Map<number, AccountCharLocation>;
}

interface RawResponse {
  characters: Array<{
    charId: number; characterId: number; characterName: string;
    online: boolean; eveSystemId: number; systemName: string | null; systemClass: string | null;
  }>;
}

// Matches the active character's location cadence (useCharacterLocation, 10 s)
// so a tracked alt's dot keeps up without doubling the per-session request rate.
// This poll plus location/online/fleet all share the esiLimiter, so several open
// tabs add up fast; 10 s (ESI caches location ~5 s anyway) keeps well clear.
const POLL_MS = 10_000;
const EMPTY: AccountLocations = { bySystem: new Map(), byChar: new Map() };

function indexBySystem(list: AccountCharLocation[]): Map<number, AccountCharLocation[]> {
  const idx = new Map<number, AccountCharLocation[]>();
  for (const c of list) {
    const arr = idx.get(c.eveSystemId);
    if (arr) arr.push(c);
    else idx.set(c.eveSystemId, [c]);
  }
  return idx;
}

// True when two polls describe the same characters in the same places, so we
// can keep the previous reference and skip the all-node re-render. Keyed by
// charId; compares only the fields a node actually renders.
function sameLocations(a: AccountLocations, b: AccountLocations): boolean {
  if (a.byChar.size !== b.byChar.size) return false;
  for (const [k, va] of a.byChar) {
    const vb = b.byChar.get(k);
    if (!vb
        || vb.eveSystemId   !== va.eveSystemId
        || vb.online        !== va.online
        || vb.systemName    !== va.systemName
        || vb.systemClass   !== va.systemClass
        || vb.characterName !== va.characterName) return false;
  }
  return true;
}

function fromList(list: AccountCharLocation[]): AccountLocations {
  const byChar = new Map<number, AccountCharLocation>();
  for (const c of list) byChar.set(c.charId, c);
  return { bySystem: indexBySystem(list), byChar };
}

const store = createPolledStore<AccountLocations>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: sameLocations,
  fetch: async () => fromList((await api<RawResponse>('/api/character/account-locations')).characters),
  // Account-wide (same for every tab of this session) — share it across tabs so
  // several open tabs make one poll total, not one each.
  crossTab: {
    key: 'account-locations',
    serialize: (v) => [...v.byChar.values()],
    deserialize: (j) => fromList(j as AccountCharLocation[]),
  },
});

/**
 * The signed-in account's OTHER characters (alts) and where each is — live when
 * online, else their last known system. Shared module cache so every SystemNode
 * consumes a single poll. Empty in share mode (no session).
 */
export function useAccountLocations(): AccountLocations {
  const { isShareMode } = useShareMode();
  return store.use(!isShareMode);
}
