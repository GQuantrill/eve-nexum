import { useEffect, useState } from 'react';

const ESI = 'https://esi.evetech.net/latest';

// One entry of ESI's /sovereignty/structures/ — every sovereignty hub in the
// cluster, with its ADM and current-or-next vulnerability window.
interface SovStructureEntry {
  solar_system_id:                number;
  alliance_id:                    number;
  structure_type_id:              number;
  vulnerability_occupancy_level?: number;
  vulnerable_start_time?:         string;
  vulnerable_end_time?:           string;
}

export interface SovHub {
  /** Activity Defense Multiplier, 1.0–6.0. */
  adm:             number | null;
  /** The current or next vulnerability window (ESI only ever gives one). */
  vulnerableStart: Date | null;
  vulnerableEnd:   Date | null;
}

const hubs = new Map<number, SovHub>();
let   load: Promise<void> | null = null;
let   loadedAt = 0;

// ESI caches this for 5 minutes. It's the whole cluster (~2,700 hubs, ~60 KB
// gzipped), so it's only fetched once someone opens a sov system's info, and
// then shared by every lookup until it goes stale.
const TTL_MS = 5 * 60 * 1000;

function ensureLoaded(): Promise<void> {
  const now = Date.now();
  if (load && now - loadedAt < TTL_MS) return load;
  loadedAt = now;
  load = fetch(`${ESI}/sovereignty/structures/`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((entries: SovStructureEntry[]) => {
      hubs.clear();
      for (const e of entries) {
        const start = e.vulnerable_start_time ? new Date(e.vulnerable_start_time) : null;
        const end   = e.vulnerable_end_time   ? new Date(e.vulnerable_end_time)   : null;
        hubs.set(e.solar_system_id, {
          adm:             typeof e.vulnerability_occupancy_level === 'number' ? e.vulnerability_occupancy_level : null,
          vulnerableStart: start && !Number.isNaN(start.getTime()) ? start : null,
          vulnerableEnd:   end   && !Number.isNaN(end.getTime())   ? end   : null,
        });
      }
    })
    .catch(() => { load = null; loadedAt = 0; }); // keep the last data; retry on the next call
  return load;
}

/**
 * The sovereignty hub in a system: its ADM and when it's next vulnerable.
 * null while loading, for systems without a hub, or if ESI can't be reached.
 */
export function useSovHub(eveSystemId: number | null): SovHub | null {
  // Tagged with the system it was found for, so a panel that stays mounted as
  // the selection changes never shows the previous system's hub.
  const [state, setState] = useState<{ id: number; hub: SovHub | null } | null>(null);

  useEffect(() => {
    if (!eveSystemId) return;
    let cancelled = false;
    const run = () => ensureLoaded().then(() => {
      if (!cancelled) setState({ id: eveSystemId, hub: hubs.get(eveSystemId) ?? null });
    });
    run();
    // Windows roll over and ADM ticks daily; re-read on the cache's cadence.
    const id = setInterval(run, TTL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [eveSystemId]);

  return eveSystemId && state?.id === eveSystemId ? state.hub : null;
}
