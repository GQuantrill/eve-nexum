import { Router } from 'express';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const telemetryRouter = Router();
const log = createLogger('telemetry');

// POST /api/telemetry — receive an opt-in anonymous deployment ping from a
// self-hosted instance: { version, instanceId }. We store ONLY those two
// fields (deliberately no IP, no user/map data) and upsert so repeated pings
// from the same install collapse to one row with a refreshed last_seen.
//
// This endpoint exists on every deployment but stays empty on all but the
// project's central collector — only instances that opted in (and point at
// this host) ever send anything.
telemetryRouter.post('/', async (req, res) => {
  const body = (req.body ?? {}) as { version?: unknown; instanceId?: unknown };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
  const version    = typeof body.version === 'string' ? body.version.trim().slice(0, 32) : '';

  // instanceId must look like the randomUUID the sender generates — cheap
  // guard against junk / spam writes.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
    return res.status(400).json({ error: 'bad instanceId' });
  }

  try {
    await db.query(
      `INSERT INTO telemetry_pings (instance_id, version, first_seen, last_seen, ping_count)
         VALUES ($1, $2, NOW(), NOW(), 1)
       ON CONFLICT (instance_id) DO UPDATE
         SET version    = EXCLUDED.version,
             last_seen  = NOW(),
             ping_count = telemetry_pings.ping_count + 1`,
      [instanceId, version || null],
    );
    return res.status(204).end();
  } catch (err) {
    log.error('store failed:', err);
    return res.status(500).json({ error: 'store failed' });
  }
});
