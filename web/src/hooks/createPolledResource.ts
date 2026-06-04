import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Factory for a cluster-wide list that's polled on a fixed cadence and shared
 * by every consumer through a single module cache + one interval. Returns a
 * `useResource()` hook (the array, live-updated) and `load()` (manual refresh).
 *
 * Replaces the byte-for-byte-identical cache/inflight/subscriber/poll-timer
 * boilerplate that each of these hooks used to carry.
 */
export function createPolledResource<T>(endpoint: string, pollMs: number) {
  let cache: { data: T[]; fetchedAt: number } | null = null;
  let inflight: Promise<T[]> | null = null;
  const subscribers = new Set<(d: T[]) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function load(): Promise<T[]> {
    if (inflight) return inflight;
    inflight = api<T[]>(endpoint)
      .then((d) => {
        cache = { data: d, fetchedAt: Date.now() };
        inflight = null;
        subscribers.forEach((fn) => fn(d));
        return d;
      })
      .catch(() => { inflight = null; return cache?.data ?? []; });
    return inflight;
  }

  function useResource(): T[] {
    const [data, setData] = useState<T[]>(cache?.data ?? []);

    useEffect(() => {
      subscribers.add(setData);
      const now = Date.now();
      if (!cache || now - cache.fetchedAt >= pollMs) load();
      else setData(cache.data);
      // Start the single shared timer on the first subscriber.
      if (!pollTimer) pollTimer = setInterval(load, pollMs);
      return () => {
        subscribers.delete(setData);
        if (subscribers.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    }, []);

    return data;
  }

  return { useResource, load };
}
