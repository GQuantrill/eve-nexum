import { Router } from 'express';
import { requireMapContentWrite, visibleMapIds } from './maps.js';
import { listSightings, recordSightings, searchKnownPilots, SIGHTING_DAYS } from '../services/pilotSightings.js';

// Pilot sightings (services/pilotSightings.ts). Reading is scoped to the maps
// the requester can see; recording needs write access to the map, the same as
// pinning a scan to it.
export const pilotsRouter = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Most pilots one read can ask about: a watch list, or a local paste's worth. */
const MAX_READ_IDS = 500;
/** Most pilots one intel line can record. */
const MAX_WRITE_PILOTS = 20;
// EVE character names are 3 to 37 characters.
const NAME_RE = /^[^\x00-\x1f]{3,37}$/;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31;

pilotsRouter.get('/sightings', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const ids = [...new Set(String(req.query.ids ?? '').split(',').map(Number).filter(isId))];
  if (ids.length === 0 || ids.length > MAX_READ_IDS) { res.status(400).json({ error: 'invalid_ids' }); return; }
  let mapIds = await visibleMapIds(req);
  const only = req.query.mapId;
  if (only != null && only !== '') {
    if (typeof only !== 'string' || !mapIds.includes(only)) { res.status(404).json({ error: 'Map not found' }); return; }
    mapIds = [only];
  }
  res.json(await listSightings(ids, mapIds));
});

// Pilots seen on the requester's maps whose name contains q: the watch list's
// suggestions. Same visibility as the sightings themselves.
pilotsRouter.get('/known', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 37 || /[\x00-\x1f]/.test(q)) { res.status(400).json({ error: 'invalid_q' }); return; }
  res.json(await searchKnownPilots(q, await visibleMapIds(req)));
});

// A watched pilot named in an intel line (the desktop app's feed).
pilotsRouter.post('/sightings', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const body = (req.body ?? {}) as { mapId?: unknown; eveSystemId?: unknown; pilots?: unknown; seenAt?: unknown };
  if (typeof body.mapId !== 'string' || !UUID_RE.test(body.mapId) || !isId(body.eveSystemId)
      || !Array.isArray(body.pilots) || body.pilots.length === 0 || body.pilots.length > MAX_WRITE_PILOTS) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const pilots: { id: number; name: string }[] = [];
  for (const p of body.pilots as Array<{ id?: unknown; name?: unknown }>) {
    if (!p || !isId(p.id) || typeof p.name !== 'string' || !NAME_RE.test(p.name.trim())) {
      res.status(400).json({ error: 'invalid_pilot' });
      return;
    }
    pilots.push({ id: p.id, name: p.name.trim() });
  }
  // The line's own time (epoch ms), for intel posted before the pilot was
  // watched: within the 30 days kept, and not ahead of now (a little clock
  // drift allowed, then clamped).
  let seenAt: Date | undefined;
  if (body.seenAt != null) {
    const ms = body.seenAt;
    const now = Date.now();
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < now - SIGHTING_DAYS * 86_400_000 || ms > now + 5 * 60_000) {
      res.status(400).json({ error: 'invalid_seen_at' });
      return;
    }
    seenAt = new Date(Math.min(ms, now));
  }
  const access = await requireMapContentWrite(res, body.mapId, req);
  if (!access) return;
  const added = await recordSightings({
    mapId: body.mapId, eveSystemId: body.eveSystemId, pilots, source: 'intel', seenBy: req.session.userId, seenAt,
  });
  res.json({ added });
});
