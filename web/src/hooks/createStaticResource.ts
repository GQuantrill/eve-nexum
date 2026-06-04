import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Factory for static cluster reference data that's loaded once per page and
 * never refreshed (a page reload recovers from any SDE re-seed). Returns a
 * `useResource()` hook and `load()`. `transform` maps the raw API payload to
 * the shape callers want (e.g. an array into a Set).
 */
export function createStaticResource<Raw, R = Raw>(
  endpoint: string,
  empty: R,
  transform: (raw: Raw) => R = (x) => x as unknown as R,
) {
  let cache: R | null = null;
  let inflight: Promise<R> | null = null;

  function load(): Promise<R> {
    if (cache) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = api<Raw>(endpoint)
      .then((raw) => { cache = transform(raw); inflight = null; return cache; })
      .catch(() => { inflight = null; return cache ?? empty; });
    return inflight;
  }

  function useResource(): R {
    const [data, setData] = useState<R>(cache ?? empty);

    useEffect(() => {
      if (cache) { setData(cache); return; }
      let cancelled = false;
      load().then((d) => { if (!cancelled) setData(d); });
      return () => { cancelled = true; };
    }, []);

    return data;
  }

  return { useResource, load };
}
