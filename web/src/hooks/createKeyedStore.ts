import { useCallback, useSyncExternalStore } from 'react';

/**
 * A per-key cache for static resources fetched by id (e.g. system metadata),
 * deduped so concurrent callers for the same key share one request and the
 * result is cached for the page's lifetime. Replaces the hand-rolled
 * "Map cache + inflight Map + setData() in a useEffect" pattern (which trips
 * react-hooks/set-state-in-effect); the value now comes from getSnapshot and a
 * completed load notifies just the watchers of that key.
 *
 * Only the fetcher differs between consumers; any per-request concerns
 * (concurrency limiting, secondary fetches) live inside `fetch`.
 */
export interface KeyedStore<K, V> {
  /** Subscribe to `key`'s value (null until loaded / when key is null). */
  use: (key: K | null) => V | null;
  /** Imperatively load + cache a key (shared with the hook's dedup). */
  load: (key: K) => Promise<V | null>;
  /** Current cached value without subscribing. */
  peek: (key: K) => V | null;
}

export function createKeyedStore<K, V>(opts: {
  fetch: (key: K) => Promise<V>;
}): KeyedStore<K, V> {
  const { fetch: doFetch } = opts;
  const cache = new Map<K, V>();
  const inflight = new Map<K, Promise<V | null>>();
  const subscribers = new Map<K, Set<() => void>>();

  function load(key: K): Promise<V | null> {
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = doFetch(key)
      .then((data) => {
        cache.set(key, data);
        subscribers.get(key)?.forEach((fn) => fn());
        return data as V | null;
      })
      .catch(() => null)
      .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  function use(key: K | null): V | null {
    const subscribe = useCallback((cb: () => void) => {
      if (key == null) return () => {};
      let set = subscribers.get(key);
      if (!set) { set = new Set(); subscribers.set(key, set); }
      set.add(cb);
      if (!cache.has(key)) void load(key);   // fetch on first access to this key
      return () => {
        set!.delete(cb);
        if (set!.size === 0) subscribers.delete(key);
      };
    }, [key]);
    const getSnapshot = useCallback(
      () => (key != null ? cache.get(key) ?? null : null),
      [key],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return { use, load, peek: (key) => cache.get(key) ?? null };
}
