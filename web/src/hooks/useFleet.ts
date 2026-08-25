import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';
import { createPolledStore } from './createPolledStore';

export interface FleetMember {
  characterId:     number;
  characterName:   string | null;
  solarSystemId:   number;
  solarSystemName: string | null;
}

export interface FleetState {
  inFleet: boolean;
  members: FleetMember[];
  /** Map from solarSystemId → members in that system. Built once per
   *  poll so SystemNode lookups are O(1). */
  bySystem: Map<number, FleetMember[]>;
}

interface RawResponse {
  inFleet: boolean;
  members: Array<{
    character_id:      number;
    character_name?:   string;
    solar_system_id:   number;
    solar_system_name?: string | null;
  }>;
}

const POLL_MS = 20_000;
const EMPTY: FleetState = { inFleet: false, members: [], bySystem: new Map() };

function indexBySystem(members: FleetMember[]): Map<number, FleetMember[]> {
  const idx = new Map<number, FleetMember[]>();
  for (const m of members) {
    const list = idx.get(m.solarSystemId);
    if (list) list.push(m);
    else idx.set(m.solarSystemId, [m]);
  }
  return idx;
}

// True when two polls describe the same fleet in the same places, so we can
// keep the previous reference and skip the all-node re-render. Members arrive
// in a stable server-driven order, so a positional compare is enough (a
// reordering only costs one redundant notify — never a stale render).
function sameFleet(a: FleetState, b: FleetState): boolean {
  if (a.inFleet !== b.inFleet || a.members.length !== b.members.length) return false;
  for (let i = 0; i < a.members.length; i++) {
    const ma = a.members[i], mb = b.members[i];
    if (ma.characterId     !== mb.characterId
        || ma.solarSystemId   !== mb.solarSystemId
        || ma.characterName   !== mb.characterName
        || ma.solarSystemName !== mb.solarSystemName) return false;
  }
  return true;
}

const store = createPolledStore<FleetState>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: sameFleet,
  fetch: async () => {
    const r = await api<RawResponse>('/api/character/fleet');
    const members: FleetMember[] = r.members.map((m) => ({
      characterId:     m.character_id,
      characterName:   m.character_name ?? null,
      solarSystemId:   m.solar_system_id,
      solarSystemName: m.solar_system_name ?? null,
    }));
    return { inFleet: r.inFleet, members, bySystem: indexBySystem(members) };
  },
});

/**
 * Subscribe to the user's current fleet roster. Shared module cache means
 * every component on the page consumes a single poll; switching from one
 * SystemNode to another doesn't multiply the ESI cost. Share viewers have no
 * session (the endpoint would 401), so they opt out and get the empty state.
 */
export function useFleet(): FleetState {
  const { isShareMode } = useShareMode();
  return store.use(!isShareMode);
}
