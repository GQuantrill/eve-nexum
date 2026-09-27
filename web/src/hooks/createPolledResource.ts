import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { readXTab, writeXTab, subscribeXTab } from './crossTabPoll';

/**
 * Factory for a cluster-wide list that's polled on a fixed cadence and shared
 * by every consumer through a single module cache + one interval. Returns a
 * `useResource()` hook (the array, live-updated) and `load()` (manual refresh).
 *
 * Replaces the byte-for-byte-identical cache/inflight/subscriber/poll-timer
 * boilerplate that each of these hooks used to carry.
 *
 * De-duplicated across tabs, keyed on the endpoint. Everything built on this is
 * cluster-wide data — incursions, insurgencies, storms — so every open tab was
 * fetching the same answer on its own timer. One tab now fetches and the rest
 * read what it published. The endpoint is a safe key: a per-parameter URL gets
 * its own entry, and localStorage is scoped to this browser profile, so what is
 * shared never leaves the session that fetched it.
 */
export function createPolledResource<T>(endpoint: string, pollMs: number) {
  let cache: { data: T[]; fetchedAt: number } | null = null;
  let inflight: Promise<T[]> | null = null;
  const subscribers = new Set<(d: T[]) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubX: (() => void) | null = null;

  function adopt(data: T[], at: number): void {
    cache = { data, fetchedAt: at };
    subscribers.forEach((fn) => fn(data));
  }

  function load(): Promise<T[]> {
    if (inflight) return inflight;
    // Another tab fetched within this interval — reuse it rather than repeating
    // the request. Strictly newer than our own read, or a lone tab adopts the
    // entry it published itself and quietly halves its own cadence.
    const shared = readXTab(endpoint, pollMs);
    if (shared !== undefined && shared.at > (cache?.fetchedAt ?? 0)) {
      adopt(shared.v as T[], shared.at);
      return Promise.resolve(cache!.data);
    }
    inflight = api<T[]>(endpoint)
      .then((d) => {
        inflight = null;
        writeXTab(endpoint, d);         // let the other tabs skip their fetch
        adopt(d, Date.now());
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
      // Live-adopt a peer's value so a tab that skipped the network still
      // updates the moment another one fetches.
      if (!unsubX) unsubX = subscribeXTab(endpoint, (v, at) => adopt(v as T[], at));
      return () => {
        subscribers.delete(setData);
        if (subscribers.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
          if (unsubX) { unsubX(); unsubX = null; }
        }
      };
    }, []);

    return data;
  }

  return { useResource, load };
}
