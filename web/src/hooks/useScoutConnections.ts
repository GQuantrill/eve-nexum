import { useSyncExternalStore } from 'react';
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
  /** Flagged collapsed — by your corp/alliance on an org install, else by you. */
  expired?:       boolean;
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
        || x.expired        !== y.expired
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

/**
 * Flag a scout connection as collapsed, or clear the flag. eve-scout keeps
 * listing a hole until someone reports it, so routing would otherwise keep
 * sending people to one that isn't there.
 */
export async function setScoutExpired(id: string, expired: boolean): Promise<void> {
  await api(`/api/scout/${encodeURIComponent(id)}/expired`, { method: expired ? 'PUT' : 'DELETE' });
  // Re-read rather than patching locally: on an org install someone else's
  // flag may have landed too, and routes have to be recomputed either way.
  store.refresh();
  bumpFlagRevision();
}

// Routes are computed server-side from the flag set, but nothing in a route
// request's inputs changes when a flag is toggled — so without this the cached
// route stands and the pane shows jump counts for a hole it's no longer using.
// Bumping a revision the route hook watches forces the recompute.
let flagRevision = 0;
const flagListeners = new Set<() => void>();
function bumpFlagRevision(): void {
  flagRevision += 1;
  flagListeners.forEach((fn) => fn());
}

export function useScoutFlagRevision(): number {
  return useSyncExternalStore(
    (fn) => { flagListeners.add(fn); return () => { flagListeners.delete(fn); }; },
    () => flagRevision,
    () => flagRevision,
  );
}
