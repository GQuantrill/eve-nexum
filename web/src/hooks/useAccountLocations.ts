import { api } from '../api/client';
import { pilotIsOffline } from './pilotActivity';
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
// Used only when the acting pilot AND every alt are logged out, at which point
// no location on the account can change.
const OFFLINE_POLL_MS = 60_000;
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

// Gating this on the ACTING pilot alone would be wrong: an alt can be in game
// while the character you're logged in as is not, and showing where those alts
// are is exactly what this endpoint is for. So it self-regulates — backing off
// only when its own last answer said nobody on the account is online either.
let anyAltOnline = false;

const store = createPolledStore<AccountLocations>({
  pollMs: POLL_MS,
  idlePollMs: OFFLINE_POLL_MS,
  idle: () => pilotIsOffline() && !anyAltOnline,
  empty: EMPTY,
  equals: sameLocations,
  fetch: async () => {
    const list = (await api<RawResponse>('/api/character/account-locations')).characters;
    anyAltOnline = list.some((c) => c.online);
    return fromList(list);
  },
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
