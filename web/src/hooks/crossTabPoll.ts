// Cross-tab poll de-duplication. Every open tab otherwise runs its own copy of
// each poll, so a handful of tabs multiply the request rate and trip the API
// rate limiter. These helpers let one tab publish a poll's latest value to
// localStorage and let the others read it (live via the `storage` event), so N
// tabs make ~one request per interval TOTAL instead of N. Values must be
// JSON-serialisable — pass a serialise/revive pair for anything holding Maps.

const PREFIX = 'nexum.xpoll.';

/** The localStorage key a given poll key is stored under (for raw listeners). */
export const xTabStorageKey = (key: string): string => PREFIX + key;

interface Entry { v: unknown; at: number }

/** A fresh cross-tab value for `key` (younger than maxAgeMs), or undefined. */
export function readXTab(key: string, maxAgeMs: number): unknown | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const e = JSON.parse(raw) as Entry;
    if (typeof e.at !== 'number' || Date.now() - e.at >= maxAgeMs) return undefined;
    return e.v;
  } catch { return undefined; }
}

/** Publish a fresh value so other tabs can skip their own fetch. */
export function writeXTab(key: string, v: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ v, at: Date.now() } as Entry)); }
  catch { /* quota / private mode — degrade gracefully to per-tab polling */ }
}

/** Notify when another tab publishes a new value for `key`. Returns a cleanup. */
export function subscribeXTab(key: string, cb: (v: unknown) => void): () => void {
  const full = PREFIX + key;
  const handler = (e: StorageEvent): void => {
    if (e.key !== full || !e.newValue) return;
    try { cb((JSON.parse(e.newValue) as Entry).v); } catch { /* ignore malformed */ }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
