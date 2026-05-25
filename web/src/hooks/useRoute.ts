import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';

export interface RouteEntry {
  jumps: number;
  path:  Array<{ id: number; name: string; security: number }>;
}

/**
 * Fetch shortest stargate-route jump count + path from `from` to each of
 * `targets`. Routing mode is read from the user prefs store ('shortest'
 * for fewest jumps, 'secure' for HS-preferring Dijkstra). JSON object
 * keys are strings, so callers look up via `routes[String(id)]`.
 */
export function useRoute(from: number | null, targets: number[]): Record<string, RouteEntry> {
  const [data, setData] = useState<Record<string, RouteEntry>>({});
  const routeMode = useMapStore((s) => s.routeMode);

  const targetsKey = [...targets].sort((a, b) => a - b).join(',');

  useEffect(() => {
    if (!from || !targetsKey) {
      setData({});
      return;
    }
    let cancelled = false;
    const url = `/api/route?from=${from}&to=${targetsKey}&mode=${routeMode}`;
    api<Record<string, RouteEntry>>(url)
      .then(r => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData({}); });
    return () => { cancelled = true; };
  }, [from, targetsKey, routeMode]);

  return data;
}
