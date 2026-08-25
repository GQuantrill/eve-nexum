import { api } from '../api/client';
import { createPolledStore } from './createPolledStore';

export interface ScoutConnection {
  id:             string;
  whType:         string;
  maxShipSize:    string;
  expiresAt:      string;
  remainingHours: number;
  outSystemId:    number;
  outSystemName:  string;
  outSignature:   string;
  inSystemId:     number;
  inSystemName:   string;
  inSystemClass:  string | null;
  inRegionId:     number;
  inRegionName:   string;
  inSignature:    string;
  whExitsOutward: boolean;
}

const POLL_MS = 5 * 60 * 1000;
const EMPTY: ScoutConnection[] = [];

// True when two polls hold the same scout connections, so we keep the previous
// reference and skip the all-node re-render. remainingHours is included so the
// ScoutConnectionsPane countdown stays live — meaning this fires mainly in the
// common no-connections case (empty === empty), which is exactly the fan-out
// worth eliminating for the majority of maps.
function sameScout(a: ScoutConnection[], b: ScoutConnection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id             !== y.id
        || x.remainingHours !== y.remainingHours
        || x.expiresAt      !== y.expiresAt
        || x.inSystemId     !== y.inSystemId
        || x.outSystemName  !== y.outSystemName) return false;
  }
  return true;
}

const store = createPolledStore<ScoutConnection[]>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: sameScout,
  fetch: () => api<ScoutConnection[]>('/api/scout'),
});

export function findScoutConnections(
  connections: ScoutConnection[],
  eveSystemId: number | null,
): ScoutConnection[] {
  if (!eveSystemId) return [];
  return connections.filter(c => c.inSystemId === eveSystemId);
}

export function useScoutConnections() {
  return store.use();
}
