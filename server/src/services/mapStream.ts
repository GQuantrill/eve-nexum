import type { Request, Response } from 'express';
import { subscribeMap } from './mapEvents.js';
import { presenceSnapshot, removePresence } from './presence.js';

// Wire an Express response up as a Server-Sent Events stream of a map's live
// edits. The CALLER is responsible for access-checking the map first; this just
// opens the stream. Shared by the cookie route (/api/maps/:id/events) and the
// API-key route (/api/v1/maps/:id/events) so both behave identically.
//
// Safe for headless (API-key) clients: presence is only ever *read* here
// (the snapshot) and the close-time presence cleanup is guarded on a session
// character, of which a key client has none.
export function streamMapEvents(req: Request, res: Response, mapId: string): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const unsubscribe = subscribeMap(mapId, res);
  // Heartbeat keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);

  // Hand the new subscriber the current presence roster so it sees who's
  // already here without waiting for the next heartbeat round.
  try {
    res.write(`data: ${JSON.stringify({ type: 'presence.snapshot', viewers: presenceSnapshot(mapId) })}\n\n`);
  } catch { /* closed */ }

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    // Closing the stream = left the map → drop this viewer's presence (TTL is
    // the backstop for unclean disconnects / multiple tabs). No-op for headless
    // key clients, which never had a session character.
    if (req.session.characterId) removePresence(mapId, req.session.characterId);
  });
}
