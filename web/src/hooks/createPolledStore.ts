import { useSyncExternalStore } from 'react';

/**
 * Shared module-level cache for a single global resource that's refreshed on a
 * timer while anything is watching it. Replaces the hand-rolled "module cache +
 * Set of setState subscribers + setState() in a useEffect" pattern (which trips
 * react-hooks/set-state-in-effect and re-implements useSyncExternalStore badly).
 *
 * One fetch feeds every consumer; the poll starts on the first subscriber and
 * stops when the last unmounts. `equals` lets the store keep the previous
 * reference when a poll returns equivalent data, so consumers don't re-render.
 * `use(false)` (e.g. in share mode) opts out entirely — no subscription, no
 * poll, returns `empty`.
 */
export interface PolledStore<T> {
  use: (enabled?: boolean) => T;
  /** Force a refetch now, but only if something is currently subscribed. */
  refresh: () => void;
  /** Current value without subscribing (for non-React callers). */
  peek: () => T;
}

export function createPolledStore<T>(opts: {
  fetch: () => Promise<T>;
  pollMs: number;
  empty: T;
  equals?: (prev: T, next: T) => boolean;
}): PolledStore<T> {
  const { fetch: doFetch, pollMs, empty, equals } = opts;

  let cache: T = empty;
  let fetchedAt = 0;
  let loaded = false;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const subscribers = new Set<() => void>();

  function load(): Promise<void> {
    if (inflight) return inflight;
    inflight = doFetch()
      .then((next) => {
        fetchedAt = Date.now();
        loaded = true;
        if (equals && equals(cache, next)) return;   // equivalent — keep ref, no re-render
        cache = next;
        subscribers.forEach((fn) => fn());
      })
      .catch(() => { /* keep the last good value */ })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    // Fetch on the first mount and whenever the cache has gone stale; the poll
    // runs while anyone is watching.
    if (!loaded || Date.now() - fetchedAt >= pollMs) load();
    if (!timer) timer = setInterval(load, pollMs);
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }

  // Stable references so useSyncExternalStore doesn't re-subscribe each render.
  const noopSubscribe = (): (() => void) => () => {};
  const getSnapshot = () => cache;
  const getEmpty = () => empty;

  return {
    use: (enabled = true) => useSyncExternalStore(
      enabled ? subscribe : noopSubscribe,
      enabled ? getSnapshot : getEmpty,
      getEmpty,
    ),
    refresh: () => { if (subscribers.size > 0) load(); },
    peek: () => cache,
  };
}
