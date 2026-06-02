import { useEffect, useState } from 'react';
import { api } from '../api/client';

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

// Static data — cache for the page's lifetime; a refresh recovers from any
// SDE re-seed. Inflight map shares one request between concurrent callers.
const cache    = new Map<number, SystemInfo>();
const inflight = new Map<number, Promise<SystemInfo | null>>();

function load(eveSystemId: number): Promise<SystemInfo | null> {
  const cached = cache.get(eveSystemId);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(eveSystemId);
  if (existing) return existing;

  const promise = api<SystemInfo>(`/api/systems/${eveSystemId}/celestials`)
    .then((data) => {
      cache.set(eveSystemId, data);
      inflight.delete(eveSystemId);
      return data;
    })
    .catch(() => {
      inflight.delete(eveSystemId);
      return null;
    });

  inflight.set(eveSystemId, promise);
  return promise;
}

export function useSystemInfo(eveSystemId: number | null): SystemInfo | null {
  const [data, setData] = useState<SystemInfo | null>(() =>
    eveSystemId ? (cache.get(eveSystemId) ?? null) : null,
  );

  useEffect(() => {
    if (!eveSystemId) { setData(null); return; }
    const hit = cache.get(eveSystemId);
    if (hit) { setData(hit); return; }
    let active = true;
    load(eveSystemId).then((d) => { if (active) setData(d); });
    return () => { active = false; };
  }, [eveSystemId]);

  return data;
}
