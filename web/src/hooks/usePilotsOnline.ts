import { api } from '../api/client';
import { createPolledStore } from './createPolledStore';

// A corp/alliance pilot Nexum has seen recently, with where they were and what
// they were flying. "Recently" is the server's window (5 min) — see the
// pilots-online route for why this is inferred rather than asked of ESI.
export interface PilotOnline {
  characterId:   number;
  characterName: string;
  shipTypeName:  string | null;
  shipName:      string | null;
  lastSeenAt:    string;
  eveSystemId:   number | null;
  systemName:    string | null;
  systemClass:   string | null;
  regionName:    string | null;
}

// 30 s. The underlying last_seen_at is only touched once a minute per pilot, so
// polling faster would re-fetch data that cannot have changed. Cross-tab
// de-duplicated like the other account-wide polls: several open tabs make one
// request per interval between them, not one each.
const POLL_MS = 30_000;
const EMPTY: PilotOnline[] = [];

function samePilots(a: PilotOnline[], b: PilotOnline[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].characterId !== b[i].characterId
        || a[i].eveSystemId !== b[i].eveSystemId
        || a[i].shipTypeName !== b[i].shipTypeName
        || a[i].lastSeenAt !== b[i].lastSeenAt) return false;
  }
  return true;
}

const store = createPolledStore<PilotOnline[]>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: samePilots,
  fetch: () => api<PilotOnline[]>('/api/character/pilots-online'),
  crossTab: {
    key: 'pilots-online',
    serialize: (v) => v,
    deserialize: (j) => (Array.isArray(j) ? j as PilotOnline[] : EMPTY),
  },
});

export function usePilotsOnline(): PilotOnline[] {
  return store.use();
}
