import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import type { Sighting } from '../utils/pilotWatch';

// Sightings of some pilots, on every map the pilot can see or just one.
// Refreshed every minute while shown, and at once after a paste
// (refreshPilotSightings), since our own paste doesn't echo back.

const REFRESH_MS = 60_000;
const MAX_IDS = 500;

let rev = 0;
const subs = new Set<() => void>();
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

export function refreshPilotSightings(): void {
  rev++;
  subs.forEach((f) => f());
}

/** null while the first load is on its way. An empty id list is []. */
export function usePilotSightings(ids: number[], mapId: string): Sighting[] | null {
  const version = useSyncExternalStore(subscribe, () => rev, () => rev);
  const wanted = [...new Set(ids)].sort((a, b) => a - b).slice(0, MAX_IDS).join(',');
  const url = wanted
    ? `/api/pilots/sightings?ids=${wanted}${mapId ? `&mapId=${encodeURIComponent(mapId)}` : ''}`
    : '';
  const [loaded, setLoaded] = useState<{ url: string; rows: Sighting[] } | null>(null);

  useEffect(() => {
    if (!url) return;
    let live = true;
    const load = () => {
      api<Sighting[]>(url)
        .then((rows) => { if (live) setLoaded({ url, rows }); })
        // A map filter for a map no longer visible answers 404: show nothing.
        .catch(() => { if (live) setLoaded({ url, rows: [] }); });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [url, version]);

  if (!url) return [];
  return loaded?.url === url ? loaded.rows : null;
}
