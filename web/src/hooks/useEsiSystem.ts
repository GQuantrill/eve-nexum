import { useEffect, useState } from 'react';

const ESI = 'https://esi.evetech.net/latest';

interface EsiPlanet {
  planet_id: number;
  moons?: number[];
  asteroid_belts?: number[];
}

export interface EsiSystemData {
  stationIds:        number[];
  planetCount:       number;
  moonCount:         number;
  stargateCount:     number;
  securityStatus:    number | null;
  constellationName: string | null;
}

// Static reference data — no TTL needed; a page refresh recovers from any CCP patch.
const cache = new Map<number, EsiSystemData>();
// Track in-flight requests so concurrent callers share one fetch, not N.
const inflight = new Map<number, Promise<EsiSystemData>>();

const constellationCache = new Map<number, string>();

// Cap how many ESI requests are in flight at once. On initial map load a 50-
// node map would otherwise issue 50 simultaneous /universe/systems/{id}/ calls;
// ESI throttles us aggressively past ~20 parallel requests and we pay for it
// in TCP setup overhead and 420 responses.
const MAX_CONCURRENT = 6;
let activeCount = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => { activeCount++; resolve(); });
  });
}

function releaseSlot() {
  activeCount--;
  const next = queue.shift();
  if (next) next();
}

async function fetchConstellationName(constellationId: number): Promise<string | null> {
  const cached = constellationCache.get(constellationId);
  if (cached) return cached;
  await acquireSlot();
  try {
    const res = await fetch(`${ESI}/universe/constellations/${constellationId}/`);
    if (!res.ok) return null;
    const data = await res.json() as { name: string };
    constellationCache.set(constellationId, data.name);
    return data.name;
  } catch {
    return null;
  } finally {
    releaseSlot();
  }
}

async function loadSystem(eveSystemId: number): Promise<EsiSystemData> {
  const cached = cache.get(eveSystemId);
  if (cached) return cached;

  const existing = inflight.get(eveSystemId);
  if (existing) return existing;

  const promise = (async (): Promise<EsiSystemData> => {
    await acquireSlot();
    try {
      const res = await fetch(`${ESI}/universe/systems/${eveSystemId}/`);
      if (!res.ok) return { stationIds: [], planetCount: 0, moonCount: 0, stargateCount: 0, securityStatus: null, constellationName: null };
      const data = await res.json() as {
        stations?: number[];
        planets?: EsiPlanet[];
        stargates?: number[];
        security_status?: number;
        constellation_id?: number;
      };
      // Release before the constellation fetch — that call acquires its own
      // slot, and holding two slots per system would halve our effective
      // concurrency.
      releaseSlot();
      const constellationName = data.constellation_id
        ? await fetchConstellationName(data.constellation_id)
        : null;
      const result: EsiSystemData = {
        stationIds:        data.stations ?? [],
        planetCount:       data.planets?.length ?? 0,
        moonCount:         data.planets?.reduce((n, p) => n + (p.moons?.length ?? 0), 0) ?? 0,
        stargateCount:     data.stargates?.length ?? 0,
        securityStatus:    data.security_status ?? null,
        constellationName,
      };
      cache.set(eveSystemId, result);
      inflight.delete(eveSystemId);
      return result;
    } catch {
      releaseSlot();
      inflight.delete(eveSystemId);
      return { stationIds: [], planetCount: 0, moonCount: 0, stargateCount: 0, securityStatus: null, constellationName: null };
    }
  })();

  inflight.set(eveSystemId, promise);
  return promise;
}

export function useEsiSystem(eveSystemId: number | null) {
  const [data, setData] = useState<EsiSystemData | null>(() =>
    eveSystemId ? (cache.get(eveSystemId) ?? null) : null,
  );

  useEffect(() => {
    if (!eveSystemId) { setData(null); return; }
    const hit = cache.get(eveSystemId);
    if (hit) { setData(hit); return; }
    loadSystem(eveSystemId).then(setData).catch(() => {});
  }, [eveSystemId]);

  return data;
}

// For components that only need the station IDs (NpcStationsPane).
export { loadSystem };
