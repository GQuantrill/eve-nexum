import { api } from '../api/client';

// Client cache of a system's stargate neighbours (eve system ids), backed by the
// same GET /api/systems/:id/adjacent (map_stargates) the "Add adjacent" menu and
// the connection gate-classifier use. Used by K-space tracking to tell a plain
// stargate hop (adjacent systems) from a wormhole / Ansiblex jump (non-adjacent),
// so the "don't track K-space" policy keeps genuine K-space-to-K-space wormhole
// connections instead of dropping them as intermediate gate hops.

const cache = new Map<number, Set<number>>();
const inflight = new Map<number, Promise<void>>();

// Fetch + cache a system's stargate neighbours, deduped by an in-flight promise
// so concurrent callers share one request. Resolves once the neighbours are
// cached (or the fetch fails — then the system stays uncached and adjacency
// checks return "unknown").
function fetchNeighbors(eveSystemId: number): Promise<void> {
  if (cache.has(eveSystemId)) return Promise.resolve();
  const existing = inflight.get(eveSystemId);
  if (existing) return existing;
  const p = api<Array<{ eveSystemId: number }>>(`/api/systems/${eveSystemId}/adjacent`)
    .then((rows) => { cache.set(eveSystemId, new Set(rows.map((r) => r.eveSystemId))); })
    .catch(() => { /* leave uncached */ })
    .finally(() => { inflight.delete(eveSystemId); });
  inflight.set(eveSystemId, p);
  return p;
}

// Warm the cache for a system (fire-and-forget). Called on each K-space arrival
// so the NEXT hop can be classified synchronously without waiting on the network.
export function prefetchStargateNeighbors(eveSystemId: number): void {
  if (eveSystemId) void fetchNeighbors(eveSystemId);
}

// As above, but awaitable — callers that filter on adjacency use this so they
// can re-render once the neighbours land.
export function loadStargateNeighbors(eveSystemId: number): Promise<void> {
  return eveSystemId ? fetchNeighbors(eveSystemId) : Promise.resolve();
}

// True ONLY when we know `from`'s neighbours and `to` IS among them — a definite
// stargate hop. Unknown (not cached / failed fetch) returns false.
export function isKnownStargateAdjacent(from: number, to: number): boolean {
  const neighbors = cache.get(from);
  return neighbors !== undefined && neighbors.has(to);
}

// True ONLY when we know `from`'s neighbours and `to` is not among them — i.e. a
// definite non-stargate (wormhole / Ansiblex) hop. Unknown (not yet cached, or a
// failed fetch) returns false, so the caller safely assumes a gate and preserves
// the prior "drop intermediate K-space" behaviour rather than over-recording.
export function isDefiniteWormholeHop(from: number, to: number): boolean {
  const neighbors = cache.get(from);
  return neighbors !== undefined && !neighbors.has(to);
}
