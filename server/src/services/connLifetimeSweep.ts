import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';
import { effectiveExpiryMs, lifeBucket, type TimeBucket } from '../data/whLifetimes.js';

const log = createLogger('connLifetimeSweep');

interface Row {
  id:                string;
  mapId:             string;
  timeStatus:        string | null;
  whType:            string | null;
  eolAt:             Date | null;
  lifetimeExpiresAt: Date | null;
  createdAt:         Date;
}

/**
 * One sweep pass: re-derive every standard wormhole connection's time bucket
 * from its effective expiry (manual override > legacy EOL mark > createdAt +
 * charted max life) and persist + broadcast the ones whose stored bucket has
 * drifted. Display-only — this never deletes or severs a connection (an expired
 * hole simply shows the expired state; sig-based removal stays with whSweep).
 *
 * The prefilter keeps the candidate set to holes with a determinable lifetime:
 * a manual/legacy timestamp, or a known non-K162 type. Untyped and bare-K162
 * connections have no computable expiry and are left untouched.
 */
async function sweepConnLifetimes(): Promise<void> {
  let rows: Row[];
  try {
    const res = await db.query<Row>(
      `SELECT id, map_id AS "mapId", time_status AS "timeStatus", wh_type AS "whType",
              eol_at AS "eolAt", lifetime_expires_at AS "lifetimeExpiresAt", created_at AS "createdAt"
         FROM map_connections
        WHERE connection_type = 'standard'
          AND broken = FALSE
          AND (lifetime_expires_at IS NOT NULL
            OR eol_at IS NOT NULL
            OR (wh_type IS NOT NULL AND wh_type <> '' AND UPPER(wh_type) <> 'K162'))`,
    );
    rows = res.rows;
  } catch (err) {
    log.warn(`candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  // Group the connections whose bucket changed, keyed by their new bucket, so a
  // whole sweep persists in at most one UPDATE per bucket value.
  const changedByBucket = new Map<TimeBucket, string[]>();
  const changed: { id: string; mapId: string; bucket: TimeBucket }[] = [];
  for (const r of rows) {
    const expiry = effectiveExpiryMs(r);
    if (expiry === null) continue;
    const bucket = lifeBucket(expiry - now);
    if (bucket === r.timeStatus) continue;
    const list = changedByBucket.get(bucket);
    if (list) list.push(r.id); else changedByBucket.set(bucket, [r.id]);
    changed.push({ id: r.id, mapId: r.mapId, bucket });
  }

  if (changed.length === 0) return;

  try {
    for (const [bucket, ids] of changedByBucket) {
      await db.query(`UPDATE map_connections SET time_status = $1 WHERE id = ANY($2::uuid[])`, [bucket, ids]);
    }
  } catch (err) {
    log.warn(`bucket update failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Bump updated_at for affected maps (so a delta-sync sees the change) and
  // broadcast each connection.update with actor null → every open client applies
  // it and its edge re-buckets live.
  const affectedMaps = new Set(changed.map((c) => c.mapId));
  for (const mapId of affectedMaps) {
    await db.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]).catch(() => {});
  }
  for (const c of changed) {
    publishToMap(c.mapId, { type: 'connection.update', actor: null, id: c.id, updates: { timeStatus: c.bucket } });
  }
  log.info(`re-bucketed ${changed.length} connection(s) across ${affectedMaps.size} map(s)`);
}

/**
 * Start the periodic connection-lifetime sweep. Cadence is
 * config.connLifetimeSweepMinutes (env CONN_LIFETIME_SWEEP_MINUTES, default 60);
 * 0 disables it. First pass runs shortly after boot.
 */
export function startConnLifetimeSweeper(): void {
  const mins = config.connLifetimeSweepMinutes;
  if (mins <= 0) { log.info('connection-lifetime sweep disabled (CONN_LIFETIME_SWEEP_MINUTES=0)'); return; }
  log.info(`connection-lifetime sweep enabled (every ${mins} min)`);
  setTimeout(() => { void sweepConnLifetimes(); }, 90_000);
  setInterval(() => { void sweepConnLifetimes(); }, mins * 60_000);
}
