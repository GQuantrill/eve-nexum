import { createKeyedStore } from './createKeyedStore';

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
  beltCount:         number;
  stargateCount:     number;
  securityStatus:    number | null;
  constellationName: string | null;
}

const BLANK: EsiSystemData = {
  stationIds: [], planetCount: 0, moonCount: 0, beltCount: 0,
  stargateCount: 0, securityStatus: null, constellationName: null,
};

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

// Static reference data, cached by the keyed store for the page's lifetime (a
// reload recovers from any CCP patch); concurrent callers for the same system
// share one fetch. A bad `system` response yields BLANK (cached, no retry); a
// network failure throws, so the store leaves it uncached and a later access
// retries — matching the original hook.
const store = createKeyedStore<number, EsiSystemData>({
  fetch: async (eveSystemId): Promise<EsiSystemData> => {
    let sys: {
      stations?: number[];
      planets?: EsiPlanet[];
      stargates?: number[];
      security_status?: number;
      constellation_id?: number;
    } | undefined;
    await acquireSlot();
    try {
      const res = await fetch(`${ESI}/universe/systems/${eveSystemId}/`);
      if (res.ok) sys = await res.json();
    } finally {
      // Release before the constellation fetch — it acquires its own slot, and
      // holding two per system would halve effective concurrency.
      releaseSlot();
    }
    if (!sys) return BLANK;
    const constellationName = sys.constellation_id
      ? await fetchConstellationName(sys.constellation_id)
      : null;
    return {
      stationIds:        sys.stations ?? [],
      planetCount:       sys.planets?.length ?? 0,
      moonCount:         sys.planets?.reduce((n, p) => n + (p.moons?.length ?? 0), 0) ?? 0,
      beltCount:         sys.planets?.reduce((n, p) => n + (p.asteroid_belts?.length ?? 0), 0) ?? 0,
      stargateCount:     sys.stargates?.length ?? 0,
      securityStatus:    sys.security_status ?? null,
      constellationName,
    };
  },
});

export function useEsiSystem(eveSystemId: number | null): EsiSystemData | null {
  return store.use(eveSystemId);
}

// For components that only need the station IDs (NpcStationsPane). Never null —
// a failed load resolves to BLANK, matching the original contract.
export function loadSystem(eveSystemId: number): Promise<EsiSystemData> {
  return store.load(eveSystemId).then((d) => d ?? BLANK);
}
