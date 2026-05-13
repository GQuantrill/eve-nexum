import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface RouteEntry {
  jumps: number;
  path:  Array<{ id: number; name: string; security: number }>;
}

/**
 * Fetch shortest stargate-route jump count + path from `from` to each of
 * `targets`. JSON object keys are strings, so callers look up via
 * `routes[String(id)]`.
 */
export function useRoute(from: number | null, targets: number[]): Record<string, RouteEntry> {
  const [data, setData] = useState<Record<string, RouteEntry>>({});

  // Stable key — re-fetch only when source or target set actually changes
  const targetsKey = [...targets].sort((a, b) => a - b).join(',');

  useEffect(() => {
    if (!from || !targetsKey) {
      setData({});
      return;
    }
    let cancelled = false;
    api<Record<string, RouteEntry>>(`/api/route?from=${from}&to=${targetsKey}`)
      .then(r => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData({}); });
    return () => { cancelled = true; };
  }, [from, targetsKey]);

  return data;
}
