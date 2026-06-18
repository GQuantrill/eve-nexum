import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';
import { whLifetimeHours } from '../data/whLifetimes.js';

const log = createLogger('whSweep');

// Coarse SQL prefilter: 4.5h is the shortest lifetime any wormhole can have, so
// a sig younger than that is never expired regardless of type. Keeps the
// per-tick candidate set tiny — fresh sigs are never even fetched.
const MIN_LIFETIME_HOURS = 4.5;

interface CandidateRow {
  id:        string;
  systemId:  string;
  mapId:     string;
  whType:    string;
  whLeadsTo: string;
  createdAt: Date;
}

interface SysRow  { id: string; name: string; systemClass: string }
interface ConnRow { id: string; sourceId: string; targetId: string; type: string | null; connectionType: string; broken: boolean }
interface SigRow  { systemId: string; whType: string; whLeadsTo: string }

/**
 * Does any sig on either endpoint of `conn` back it — i.e. point at the
 * opposite system by class or name? Mirrors the client's heuristic in
 * utils/whAutoDetect.ts so live edits and the sweep agree on what "backs" a
 * connection.
 */
function isBacked(
  conn: ConnRow,
  sigsBySystem: Map<string, SigRow[]>,
  systemsById: Map<string, SysRow>,
): boolean {
  for (const [near, far] of [[conn.sourceId, conn.targetId], [conn.targetId, conn.sourceId]] as const) {
    const other = systemsById.get(far);
    if (!other) continue;
    const oc = other.systemClass.toUpperCase();
    const on = (other.name ?? '').toUpperCase();
    for (const sig of sigsBySystem.get(near) ?? []) {
      if (!sig.whType || !sig.whLeadsTo) continue;
      const target = sig.whLeadsTo.toUpperCase();
      if (target === oc || target === on) return true;
    }
  }
  return false;
}

/**
 * Did one of the just-deleted sigs back this connection? True when a deleted
 * sig sat on an endpoint, pointed at the opposite endpoint (class/name), and
 * the connection's current type came from it (type === the sig's whType). The
 * type match keeps us from quarantining a link whose code the user typed by
 * hand — same guard as the client's `oldBackedThis`.
 */
function wasBackedByDeleted(
  conn: ConnRow,
  deleted: CandidateRow[],
  systemsById: Map<string, SysRow>,
): boolean {
  if (!conn.type) return false;
  const connType = conn.type.toUpperCase();
  for (const d of deleted) {
    if (!d.whType || !d.whLeadsTo) continue;
    if (d.whType.toUpperCase() !== connType) continue;
    const near = d.systemId === conn.sourceId ? conn.sourceId
               : d.systemId === conn.targetId ? conn.targetId
               : null;
    if (!near) continue;
    const far = near === conn.sourceId ? conn.targetId : conn.sourceId;
    const other = systemsById.get(far);
    if (!other) continue;
    const target = d.whLeadsTo.toUpperCase();
    if (target === other.systemClass.toUpperCase() || target === (other.name ?? '').toUpperCase()) return true;
  }
  return false;
}

/**
 * Process one map's expired sigs in a transaction: delete them, quarantine any
 * connection they backed that nothing else backs, then broadcast the changes
 * so open clients update live (sig.changed re-fetches the system's sig list;
 * connection.update flips `broken` on the edge).
 */
async function sweepMap(mapId: string, expired: CandidateRow[]): Promise<void> {
  const expiredIds = expired.map((e) => e.id);
  const client = await db.connect();
  let brokenIds: string[] = [];
  try {
    await client.query('BEGIN');

    const [sysRes, connRes] = await Promise.all([
      client.query<SysRow>(
        `SELECT id, name, system_class AS "systemClass" FROM map_systems WHERE map_id = $1`, [mapId]),
      client.query<ConnRow>(
        `SELECT id, source_id AS "sourceId", target_id AS "targetId", wh_type AS "type",
                connection_type AS "connectionType", broken
           FROM map_connections WHERE map_id = $1`, [mapId]),
    ]);

    await client.query(`DELETE FROM map_signatures WHERE id = ANY($1::uuid[])`, [expiredIds]);

    // Backing sigs that REMAIN after the delete — query post-delete so we don't
    // have to reconcile the removed rows by hand.
    const sigRes = await client.query<SigRow>(
      `SELECT s.system_id AS "systemId", s.wh_type AS "whType", s.wh_leads_to AS "whLeadsTo"
         FROM map_signatures s JOIN map_systems sys ON sys.id = s.system_id
        WHERE sys.map_id = $1 AND s.wh_type <> '' AND s.wh_leads_to <> ''`, [mapId]);

    const systemsById = new Map(sysRes.rows.map((s) => [s.id, s]));
    const sigsBySystem = new Map<string, SigRow[]>();
    for (const sig of sigRes.rows) {
      const list = sigsBySystem.get(sig.systemId);
      if (list) list.push(sig); else sigsBySystem.set(sig.systemId, [sig]);
    }

    brokenIds = connRes.rows
      .filter((c) => c.connectionType === 'standard' && !c.broken)
      .filter((c) => wasBackedByDeleted(c, expired, systemsById))
      .filter((c) => !isBacked(c, sigsBySystem, systemsById))
      .map((c) => c.id);

    if (brokenIds.length > 0) {
      await client.query(`UPDATE map_connections SET broken = TRUE WHERE id = ANY($1::uuid[])`, [brokenIds]);
    }
    await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.warn(`sweep failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    client.release();
  }

  // Broadcast outside the transaction. Server-originated → actor null so every
  // connected client applies it (none will match their own CLIENT_ID).
  const affectedSystems = new Set(expired.map((e) => e.systemId));
  for (const systemId of affectedSystems) {
    publishToMap(mapId, { type: 'sig.changed', actor: null, systemId });
  }
  for (const id of brokenIds) {
    publishToMap(mapId, { type: 'connection.update', actor: null, id, updates: { broken: true } });
  }
  log.info(`map ${mapId}: removed ${expiredIds.length} aged WH sig(s), quarantined ${brokenIds.length} connection(s)`);
}

/** One sweep pass over every opted-in map. */
async function sweepAll(): Promise<void> {
  let rows: CandidateRow[];
  try {
    const res = await db.query<CandidateRow>(
      `SELECT s.id, s.system_id AS "systemId", sys.map_id AS "mapId",
              s.wh_type AS "whType", s.wh_leads_to AS "whLeadsTo", s.created_at AS "createdAt"
         FROM map_signatures s
         JOIN map_systems sys ON sys.id = s.system_id
         JOIN maps m ON m.id = sys.map_id
        WHERE m.lazy_remove_wormholes = TRUE
          AND s.sig_type = 'wormhole'
          AND s.created_at < NOW() - ($1 || ' hours')::interval`,
      [String(MIN_LIFETIME_HOURS)],
    );
    rows = res.rows;
  } catch (err) {
    log.warn(`candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  const byMap = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const maxH = whLifetimeHours(r.whType);
    if (maxH === null) continue; // unknown code → never auto-remove
    const ageH = (now - new Date(r.createdAt).getTime()) / 3_600_000;
    if (ageH <= maxH) continue;
    const list = byMap.get(r.mapId);
    if (list) list.push(r); else byMap.set(r.mapId, [r]);
  }

  for (const [mapId, expired] of byMap) {
    await sweepMap(mapId, expired);
  }
}

/**
 * Start the periodic lazy WH-removal sweep. Cadence is config.lazyWhSweepMinutes
 * (env LAZY_WH_SWEEP_MINUTES, default 15); 0 disables it. First pass runs a
 * short while after boot so startup isn't competing with it.
 */
export function startWhSweeper(): void {
  const mins = config.lazyWhSweepMinutes;
  if (mins <= 0) { log.info('lazy WH-removal sweep disabled (LAZY_WH_SWEEP_MINUTES=0)'); return; }
  log.info(`lazy WH-removal sweep enabled (every ${mins} min)`);
  setTimeout(() => { void sweepAll(); }, 60_000);
  setInterval(() => { void sweepAll(); }, mins * 60_000);
}
