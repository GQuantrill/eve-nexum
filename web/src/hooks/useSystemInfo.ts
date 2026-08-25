import { api } from '../api/client';
import { createKeyedStore } from './createKeyedStore';

/**
 * Static celestial metadata for the system-info panel: security status,
 * constellation, sun type and the planet / moon / belt / stargate counts.
 *
 * Served by GET /api/systems/:id/celestials, which reads our SDE-seeded
 * columns and only falls back to live ESI server-side for a system that
 * hasn't been re-seeded yet. So the client just fetches one endpoint — no
 * direct ESI call from the browser. (The map-node star icon and the NPC
 * stations pane still use useEsiSystem / loadSystem for their own needs.)
 */
export interface SystemInfo {
  securityStatus:    number | null;
  constellationName: string | null;
  sunType:           string | null;
  planetCount:       number;
  moonCount:         number;
  beltCount:         number;
  stargateCount:     number;
}

// Static data — cached for the page's lifetime (a reload recovers from any SDE
// re-seed); concurrent callers for the same system share one request.
const store = createKeyedStore<number, SystemInfo>({
  fetch: (eveSystemId) => api<SystemInfo>(`/api/systems/${eveSystemId}/celestials`),
});

export function useSystemInfo(eveSystemId: number | null): SystemInfo | null {
  return store.use(eveSystemId);
}
