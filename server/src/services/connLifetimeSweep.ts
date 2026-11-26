import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';
import { effectiveExpiryMs, lifeBucket, UNTYPED_SEVER_HOURS, type TimeBucket } from '../data/whLifetimes.js';

const log = createLogger('connLifetimeSweep');

interface Row {
  id:                string;
  mapId:             string;
  timeStatus:        string | null;
  whType:            string | null;
  eolAt:             Date | null;
  lifetimeExpiresAt: Date | null;
  createdAt:         Date;
  sourceId:          string;
  targetId:          string;
  sourceSignatureId: string | null;
  targetSignatureId: string | null;
  lazyRemove:        boolean;
  graceHours:        number;
}

export type LifetimeAction =
  | { kind: 'none' }
  | { kind: 'rebucket'; bucket: TimeBucket }
  | { kind: 'collapse' }
  | { kind: 'sever' };

/**
 * Decide what the sweep should do with one connection (pure, so it's unit
 * tested without a DB):
 *   - expired for longer than the grace period: on a lazy-removal map,
 *     collapse it (sever + drop its backing sigs: a dead hole has no sig on
 *     the scanner); on any other map, only sever it (greyed out, nothing
 *     deleted), so Remove orphans can find what's behind it;
 *   - otherwise re-bucket if the stored status has drifted from the live one.
 * Every wormhole dies: one with no lifetime of its own (untyped, or a code we
 * don't know) is severed UNTYPED_SEVER_HOURS after it was found (plus grace),
 * on any map, but its sigs are kept and it isn't deleted before the 48h
 * ceiling (removeStaleBrokenConnections), so a live 48h hole can be restored.
 * It has no bucket to show.
 * Collapse takes priority over re-bucketing so an over-grace hole doesn't first
 * get stamped 'expired' only to be severed the same tick.
 */
export function connLifetimeAction(
  row: Pick<Row, 'timeStatus' | 'whType' | 'eolAt' | 'lifetimeExpiresAt' | 'createdAt' | 'lazyRemove'>,
  now: number,
  graceMs: number,
): LifetimeAction {
  const expiry = effectiveExpiryMs(row);
  if (expiry === null) {
    const aged = now - new Date(row.createdAt).getTime() - UNTYPED_SEVER_HOURS * 3_600_000;
    return aged > graceMs ? { kind: 'sever' } : { kind: 'none' };
  }
  if (now - expiry > graceMs) return { kind: row.lazyRemove ? 'collapse' : 'sever' };
  const bucket = lifeBucket(expiry - now);
  return bucket === row.timeStatus ? { kind: 'none' } : { kind: 'rebucket', bucket };
}

/**
 * Collapse one map's over-grace connections in a transaction: delete the
 * wormhole sigs backing them, sever the connections (broken = true), then
 * broadcast so open clients drop the sigs and render the severed edge live.
 */
async function collapseMap(mapId: string, conns: Row[], dropSigs: boolean): Promise<void> {
  const connIds = conns.map((c) => c.id);
  const sigIds = dropSigs
    ? conns.flatMap((c) => [c.sourceSignatureId, c.targetSignatureId]).filter((x): x is string => !!x)
    : [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (sigIds.length) await client.query(`DELETE FROM map_signatures WHERE id = ANY($1::uuid[])`, [sigIds]);
    await client.query(
      `UPDATE map_connections SET broken = TRUE, broken_at = NOW() WHERE id = ANY($1::uuid[])`, [connIds]);
    await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.warn(`collapse failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    client.release();
  }

  if (sigIds.length) {
    const affectedSystems = new Set(conns.flatMap((c) => [c.sourceId, c.targetId]));
    for (const systemId of affectedSystems) publishToMap(mapId, { type: 'sig.changed', actor: null, systemId });
  }
  for (const id of connIds) publishToMap(mapId, { type: 'connection.update', actor: null, id, updates: { broken: true } });
  log.info(dropSigs
    ? `map ${mapId}: collapsed ${connIds.length} expired connection(s), removed ${sigIds.length} sig(s)`
    : `map ${mapId}: severed ${connIds.length} expired connection(s)`);
}

/**
 * One sweep pass: for every standard wormhole connection with a determinable
 * lifetime, either re-bucket its stored time_status (all maps) or — once it has
 * been expired past the grace period on a lazy-removal map — collapse it. Purely
 * display/state work: re-bucketing never deletes; collapse mirrors a real hole
 * dying (sig gone, connection severed) and only fires where the map opted in.
 *
 * Every live wormhole connection is a candidate: one without a lifetime of its
 * own is still severed by age (connLifetimeAction).
 */
async function sweepConnLifetimes(): Promise<void> {
  let rows: Row[];
  try {
    const res = await db.query<Row>(
      `SELECT c.id, c.map_id AS "mapId", c.time_status AS "timeStatus", c.wh_type AS "whType",
              c.eol_at AS "eolAt", c.lifetime_expires_at AS "lifetimeExpiresAt", c.created_at AS "createdAt",
              c.source_id AS "sourceId", c.target_id AS "targetId",
              c.source_signature_id AS "sourceSignatureId", c.target_signature_id AS "targetSignatureId",
              m.lazy_remove_wormholes AS "lazyRemove", m.collapse_grace_hours AS "graceHours"
         FROM map_connections c
         JOIN maps m ON m.id = c.map_id
        WHERE c.connection_type = 'standard'
          AND c.broken = FALSE`,
    );
    rows = res.rows;
  } catch (err) {
    log.warn(`candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  // Re-bucket updates grouped by their new bucket (one UPDATE per bucket value);
  // collapses grouped by map (one transaction per map).
  const changedByBucket = new Map<TimeBucket, string[]>();
  const rebucketed: { id: string; mapId: string; bucket: TimeBucket }[] = [];
  const collapseByMap = new Map<string, Row[]>();
  const severByMap = new Map<string, Row[]>();

  for (const r of rows) {
    // Grace is per-map (map settings). Each connection carries its map's value.
    const action = connLifetimeAction(r, now, r.graceHours * 3_600_000);
    if (action.kind === 'collapse' || action.kind === 'sever') {
      const byMap = action.kind === 'collapse' ? collapseByMap : severByMap;
      const list = byMap.get(r.mapId);
      if (list) list.push(r); else byMap.set(r.mapId, [r]);
    } else if (action.kind === 'rebucket') {
      const list = changedByBucket.get(action.bucket);
      if (list) list.push(r.id); else changedByBucket.set(action.bucket, [r.id]);
      rebucketed.push({ id: r.id, mapId: r.mapId, bucket: action.bucket });
    }
  }

  if (rebucketed.length > 0) {
    try {
      for (const [bucket, ids] of changedByBucket) {
        await db.query(`UPDATE map_connections SET time_status = $1 WHERE id = ANY($2::uuid[])`, [bucket, ids]);
      }
      const rebucketMaps = new Set(rebucketed.map((c) => c.mapId));
      for (const mapId of rebucketMaps) {
        await db.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]).catch(() => {});
      }
      for (const c of rebucketed) {
        publishToMap(c.mapId, { type: 'connection.update', actor: null, id: c.id, updates: { timeStatus: c.bucket } });
      }
      log.info(`re-bucketed ${rebucketed.length} connection(s) across ${rebucketMaps.size} map(s)`);
    } catch (err) {
      log.warn(`bucket update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [mapId, conns] of collapseByMap) await collapseMap(mapId, conns, true);
  for (const [mapId, conns] of severByMap) await collapseMap(mapId, conns, false);
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
