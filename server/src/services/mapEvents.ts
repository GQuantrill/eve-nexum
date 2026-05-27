import type { Response } from 'express';

// In-memory registry of SSE subscribers, keyed by map id. One process only —
// if Nexum is ever scaled to multiple server instances, replace the fan-out
// here with Postgres LISTEN/NOTIFY (keep this module as the seam). See
// realtime_sync_feature.md.
const subscribers = new Map<string, Set<Response>>();

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

// Push an event to every client currently viewing this map. No-op when nobody
// is subscribed, so mutation routes can fire-and-forget cheaply.
export function publishToMap(mapId: string, event: MapEvent): void {
  const set = subscribers.get(mapId);
  if (!set || set.size === 0) return;
  // Default (unnamed) SSE message — the client dispatches on event.type via a
  // single onmessage handler rather than one listener per event name.
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { /* dead connection; req close handler cleans it up */ }
  }
}
