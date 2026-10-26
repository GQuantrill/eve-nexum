import { Router } from 'express';
import { db } from '../db.js';
import { getMapAccess, requireMapContentWrite } from './maps.js';
import { publishToMap } from '../services/mapEvents.js';
import { dscanCreateLimiter, dscanHourlyLimiter } from '../middleware/rateLimits.js';
import { createLogger } from '../utils/logger.js';
import {
  parsePaste, analyseDscan, analyseLocal, saveScan, getScan, listSystemScans,
  LocalLookupError, MAX_PASTE_CHARS,
} from '../services/dscan.js';

const log = createLogger('dscan');

// Public on purpose: creating and viewing a scan needs no login. Only pinning a
// scan to a map system, and listing a system's scans, need a session -- and
// then the same map access every other per-system route checks.
export const dscanRouter = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

dscanRouter.post('/', dscanCreateLimiter, dscanHourlyLimiter, async (req, res) => {
  const body = (req.body ?? {}) as { text?: unknown; mapId?: unknown; systemId?: unknown };
  if (typeof body.text !== 'string' || body.text.length > MAX_PASTE_CHARS) {
    res.status(400).json({ error: 'invalid_text' });
    return;
  }

  // Resolve the attachment first: a request that asks to pin and isn't allowed
  // to should fail outright, not quietly save an unpinned scan.
  let mapId: string | null = null;
  let eveSystemId: number | null = null;
  if (body.mapId != null || body.systemId != null) {
    if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
    if (typeof body.mapId !== 'string' || typeof body.systemId !== 'string' ||
        !UUID_RE.test(body.mapId) || !UUID_RE.test(body.systemId)) {
      res.status(400).json({ error: 'invalid_attachment' });
      return;
    }
    const access = await requireMapContentWrite(res, body.mapId, req);
    if (!access) return;
    const { rows } = await db.query<{ eve_system_id: number | null }>(
      `SELECT eve_system_id FROM map_systems WHERE id = $1 AND map_id = $2`, [body.systemId, body.mapId]);
    if (!rows[0] || rows[0].eve_system_id == null) { res.status(404).json({ error: 'System not found' }); return; }
    mapId = body.mapId;
    eveSystemId = rows[0].eve_system_id;
  }

  const parsed = parsePaste(body.text);
  if (parsed.kind === 'error') { res.status(400).json({ error: parsed.error }); return; }

  let data;
  try {
    data = parsed.kind === 'dscan' ? await analyseDscan(parsed.rows) : await analyseLocal(parsed.names);
  } catch (err) {
    if (err instanceof LocalLookupError) { res.status(502).json({ error: 'lookup_failed' }); return; }
    throw err;
  }

  const saved = await saveScan({ data, createdBy: req.session.userId ?? null, mapId, eveSystemId });
  if (mapId && eveSystemId != null) {
    publishToMap(mapId, { type: 'dscan.changed', actor: req.get('x-client-id') ?? null, eveSystemId });
  }
  log.info(`created ${parsed.kind} scan${mapId ? ' (pinned)' : ''}`);
  res.status(201).json({ id: saved.id, expiresAt: saved.expiresAt, kind: data.kind });
});

// Scans pinned to a system on a map. Before /:id so "map" isn't read as an id.
dscanRouter.get('/map/:mapId/system/:eveSystemId', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { mapId } = req.params;
  const eveSystemId = Number(req.params.eveSystemId);
  if (!Number.isInteger(eveSystemId) || eveSystemId <= 0) { res.status(400).json({ error: 'invalid_system' }); return; }
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  res.json(await listSystemScans(mapId, eveSystemId));
});

dscanRouter.get('/:id', async (req, res) => {
  const found = await getScan(req.params.id);
  if (found.status === 'not_found') { res.status(404).json({ error: 'not_found' }); return; }
  if (found.status === 'expired') { res.status(410).json({ error: 'expired' }); return; }
  res.json(found.scan);
});
