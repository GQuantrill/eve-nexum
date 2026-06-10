import type { Response } from 'express';

// In-memory registry of SSE subscribers, keyed by map id. One process only —
// if Nexum is ever scaled to multiple server instances, replace the fan-out
// here with Postgres LISTEN/NOTIFY (keep this module as the seam). See
// realtime_sync_feature.md.
const subscribers = new Map<string, Set<Response>>();

// Parallel registry of plain callbacks, keyed by map id. Unlike `subscribers`
// (which get the raw event written to their SSE response), these receive the
// event object so the caller can transform it. Used by the public share stream,
// which must NOT forward event payloads to an unauthenticated client — it turns
// every event into a content-free "changed" ping instead.
type MapEventListener = (event: MapEvent) => void;
const listeners = new Map<string, Set<MapEventListener>>();

export interface MapEvent {
  type: string;            // e.g. 'system.add'
  actor?: string | null;   // originating client id, for echo suppression
  [key: string]: unknown;
}

// Register an SSE response under a map. Returns an unsubscribe fn.
export function subscribeMap(mapId: string, res: Response): () => void {
  let set = subscribers.get(mapId);
  if (!set) { set = new Set(); subscribers.set(mapId, set); }
  set.add(res);
  return () => {
    const s = subscribers.get(mapId);
    if (!s) return;
    s.delete(res);
    if (s.size === 0) subscribers.delete(mapId);
  };
}

// Register a transform callback for a map's events. Returns an unsubscribe fn.
// The callback gets the event object (not an SSE frame), so the caller decides
// what, if anything, to forward.
export function onMapEvent(mapId: string, fn: MapEventListener): () => void {
  let set = listeners.get(mapId);
  if (!set) { set = new Set(); listeners.set(mapId, set); }
  set.add(fn);
  return () => {
    const s = listeners.get(mapId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(mapId);
  };
}

// Push an event to every client currently viewing this map, and to every
// registered callback listener. Cheap no-op when neither exists, so mutation
// routes can fire-and-forget.
export function publishToMap(mapId: string, event: MapEvent): void {
  const set = subscribers.get(mapId);
  if (set && set.size > 0) {
    // Default (unnamed) SSE message — the client dispatches on event.type via a
    // single onmessage handler rather than one listener per event name.
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try { res.write(frame); } catch { /* dead connection; req close handler cleans it up */ }
    }
  }
  const ls = listeners.get(mapId);
  if (ls && ls.size > 0) {
    for (const fn of ls) {
      try { fn(event); } catch { /* a listener must never break the publish */ }
    }
  }
}
