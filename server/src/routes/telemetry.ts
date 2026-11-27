import { Router } from 'express';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const telemetryRouter = Router();
const log = createLogger('telemetry');

// POST /api/telemetry — receive an anonymous deployment ping from an install:
// { version, instanceId, mapCount, userCount, stats? }. We store only the
// version, a random instance id, and aggregate counts
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

const COUNT_KEYS = ['active1d', 'active7d', 'active30d', 'accounts30d', 'desktop30d', 'maps30d'] as const;
const FEATURE_KEYS = ['chainNumbering', 'autoRemove', 'crossMapSync', 'discord'] as const;
const MODES = new Set(['solo', 'corp', 'alliance']);

/** The usage counts from a ping, keeping only known keys and sane numbers (an
 *  older install sends none). */
function cleanStats(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of COUNT_KEYS) { const n = toCount(o[k]); if (n != null) out[k] = n; }
  if (typeof o.mode === 'string' && MODES.has(o.mode)) out.mode = o.mode;
  if (o.features && typeof o.features === 'object') {
    const f: Record<string, number> = {};
    for (const k of FEATURE_KEYS) { const n = toCount((o.features as Record<string, unknown>)[k]); if (n != null) f[k] = n; }
    out.features = f;
  }
  if (o.languages && typeof o.languages === 'object') {
    const l: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.languages as Record<string, unknown>).slice(0, 20)) {
      const c = toCount(n);
      if (/^[a-z]{2}$/.test(k) && c != null) l[k] = c;
    }
    out.languages = l;
  }
  return out;
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

  const stats = cleanStats((req.body as { stats?: unknown }).stats);

  try {
    // One row per install per day: the history the usage page sums by month.
    await db.query(
      `INSERT INTO telemetry_daily (instance_id, day, version, stats) VALUES ($1, CURRENT_DATE, $2, $3)
       ON CONFLICT (instance_id, day) DO UPDATE SET version = EXCLUDED.version, stats = EXCLUDED.stats`,
      [instanceId, version || null, JSON.stringify({ ...stats, mapCount, userCount })],
    );
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
