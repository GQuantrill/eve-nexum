// Cross-tab poll de-duplication. Every open tab otherwise runs its own copy of
// each poll, so a handful of tabs multiply the request rate and trip the API
// rate limiter. These helpers let one tab publish a poll's latest value to
// localStorage and let the others read it (live via the `storage` event), so N
// tabs make ~one request per interval TOTAL instead of N. Values must be
// JSON-serialisable — pass a serialise/revive pair for anything holding Maps.

const PREFIX = 'nexum.xpoll.';

/** The localStorage key a given poll key is stored under (for raw listeners). */
export const xTabStorageKey = (key: string): string => PREFIX + key;

export interface Entry { v: unknown; at: number }

/**
 * A fresh cross-tab value for `key` (published less than maxAgeMs ago), or
 * undefined. The publish time comes back with it: an adopting tab must age the
 * value from when the PEER fetched it, not from when it read it, or a value
 * that's nearly a full interval old is recorded — and displayed — as brand new.
 */
export function readXTab(key: string, maxAgeMs: number): Entry | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const e = JSON.parse(raw) as Entry;
    if (typeof e.at !== 'number' || Date.now() - e.at >= maxAgeMs) return undefined;
    return e;
  } catch { return undefined; }
}

/** Publish a fresh value so other tabs can skip their own fetch. */
export function writeXTab(key: string, v: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ v, at: Date.now() } as Entry)); }
  catch { /* quota / private mode — degrade gracefully to per-tab polling */ }
}

/** Notify when another tab publishes a new value for `key`. Returns a cleanup. */
export function subscribeXTab(key: string, cb: (v: unknown, at: number) => void): () => void {
  const full = PREFIX + key;
  const handler = (e: StorageEvent): void => {
    if (e.key !== full || !e.newValue) return;
    try { const p = JSON.parse(e.newValue) as Entry; cb(p.v, p.at); } catch { /* ignore malformed */ }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
