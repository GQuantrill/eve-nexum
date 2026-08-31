import { api } from '../api/client';
import type { Signature } from '../types';

/**
 * Pending overwrite-paste signature removals.
 *
 * An overwrite paste doesn't delete a despawned sig outright: it marks the row
 * struck-through and deletes it after a grace period (default 10 s, up to 2 min)
 * so the user can see what's going and clear the in-game bookmarks first.
 *
 * That grace period used to be a setTimeout owned by SignaturePane, which made
 * the deletion conditional on the pane staying mounted on that system until the
 * timer fired — and the pane clears its timers on every system switch. Clearing
 * bookmarks means hopping the chain, so the normal workflow cancelled the very
 * deletions it had just scheduled and the despawned sigs silently survived.
 *
 * The queue owns them instead: each entry carries the map + system it belongs
 * to, so it fires wherever the user has navigated to, and a page close flushes
 * what's still outstanding rather than dropping it.
 */

interface Pending {
  mapId:    string;
  systemId: string;
  sig:      Signature;
  timer:    ReturnType<typeof setTimeout> | null;
}

/** Keyed by signature row id (a UUID — unique across systems). */
const pending = new Map<string, Pending>();
const listeners = new Set<(e: RemovalEvent) => void>();

export interface RemovalEvent {
  /** 'scheduled' / 'cancelled' only move the indicator; 'removed' means the row is gone. */
  kind:     'scheduled' | 'cancelled' | 'removed';
  sigRowId: string;
  systemId: string;
  /** The removed signature — subscribers need it to re-evaluate connections. */
  sig?:     Signature;
}

function emit(e: RemovalEvent): void {
  listeners.forEach((fn) => fn(e));
}

/** Notified when a pending removal is scheduled, cancelled, or carried out. */
export function subscribeSigRemovals(cb: (e: RemovalEvent) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Row ids currently marked for removal in `systemId` — drives the row styling. */
export function pendingRemovalIds(systemId: string): Set<string> {
  const out = new Set<string>();
  for (const p of pending.values()) if (p.systemId === systemId) out.add(p.sig.id);
  return out;
}

// Carry out one removal. `keepalive` lets it survive the page unloading.
function commit(p: Pending, keepalive = false): void {
  if (p.timer) clearTimeout(p.timer);
  pending.delete(p.sig.id);
  api(`/api/maps/${p.mapId}/systems/${p.systemId}/signatures/${p.sig.id}`, { method: 'DELETE', keepalive })
    .catch(() => { /* best-effort: a failed delete leaves the row for the next paste to re-flag */ });
  // Subscribers drop the row locally and, when the pane is mounted on this
  // system, quarantine any connection the sig was backing. When it isn't, the
  // pane's own orphaned-wormhole sweep catches it on the next visit.
  emit({ kind: 'removed', sigRowId: p.sig.id, systemId: p.systemId, sig: p.sig });
}

/**
 * Mark a despawned sig for removal after `delaySec`. `delaySec <= 0` removes it
 * at once. Rescheduling an already-pending sig restarts its grace period.
 */
export function scheduleSigRemoval(mapId: string, systemId: string, sig: Signature, delaySec: number): void {
  const existing = pending.get(sig.id);
  if (existing?.timer) clearTimeout(existing.timer);

  const entry: Pending = { mapId, systemId, sig, timer: null };
  if (delaySec <= 0) {
    pending.set(sig.id, entry);
    commit(entry);
    return;
  }
  entry.timer = setTimeout(() => commit(entry), delaySec * 1000);
  pending.set(sig.id, entry);
  emit({ kind: 'scheduled', sigRowId: sig.id, systemId });
}

/**
 * Drop a pending removal without deleting — the sig came back in a later paste,
 * or the row has already gone (manual delete).
 */
export function cancelSigRemoval(sigRowId: string): void {
  const p = pending.get(sigRowId);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pending.delete(sigRowId);
  emit({ kind: 'cancelled', sigRowId, systemId: p.systemId });
}

/**
 * Carry out every outstanding removal immediately. Bound to `pagehide` below:
 * the user asked for these sigs to go, so a closed tab must commit them rather
 * than lose them. keepalive keeps the DELETEs alive past the unload.
 */
export function flushSigRemovals(): void {
  for (const p of [...pending.values()]) commit(p, true);
}

if (typeof window !== 'undefined') {
  // pagehide (not beforeunload) — it fires for bfcache navigations and mobile
  // tab eviction too, which is where the "closed the tab and the sigs came
  // back" reports come from.
  window.addEventListener('pagehide', flushSigRemovals);
}
