import { Router } from 'express';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const telemetryRouter = Router();
const log = createLogger('telemetry');

// POST /api/telemetry — receive an opt-in anonymous deployment ping from a
// self-hosted instance: { version, instanceId, mapCount, userCount }. We store
// only the version, a random instance id, and the two aggregate counts
// (deliberately no IP, no identifying user/map data) and upsert so repeated
// pings from the same install collapse to one row with a refreshed last_seen.
//
// This endpoint exists on every deployment but stays empty on all but the
// project's central collector — only instances that opted in (and point at
// this host) ever send anything.

// Coerce an untrusted count to a sane non-negative integer, or null. Caps at a
// generous ceiling so a bogus payload can't store absurd values.
function toCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 0) return null;
  return Math.min(n, 100_000_000);
}

telemetryRouter.post('/', async (req, res) => {
  const body = (req.body ?? {}) as { version?: unknown; instanceId?: unknown; mapCount?: unknown; userCount?: unknown };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
  const version    = typeof body.version === 'string' ? body.version.trim().slice(0, 32) : '';
  const mapCount   = toCount(body.mapCount);
  const userCount  = toCount(body.userCount);

  // instanceId must look like the randomUUID the sender generates — cheap
  // guard against junk / spam writes.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
    return res.status(400).json({ error: 'bad instanceId' });
  }

  try {
    await db.query(
      `INSERT INTO telemetry_pings (instance_id, version, map_count, user_count, first_seen, last_seen, ping_count)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), 1)
       ON CONFLICT (instance_id) DO UPDATE
         SET version    = EXCLUDED.version,
             map_count  = EXCLUDED.map_count,
             user_count = EXCLUDED.user_count,
             last_seen  = NOW(),
             ping_count = telemetry_pings.ping_count + 1`,
      [instanceId, version || null, mapCount, userCount],
    );
    return res.status(204).end();
  } catch (err) {
    log.error('store failed:', err);
    return res.status(500).json({ error: 'store failed' });
  }
});
