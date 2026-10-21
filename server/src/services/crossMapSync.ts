import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';

const log = createLogger('cross-map-sync');

// Non-destructive propagation of signatures / anomalies to the *same* EVE
// system on related maps. When you scan a system on one map, the same hole on
// the related maps gets the new sigs/anoms too -- added if missing, and blank
// fields filled in, but never overwriting data already entered there and never
// deleting anything.
//
// Scopes never mix -- intel only moves between maps of the same kind:
//   - personal map  -> the same account's other personal maps (all its
//                      characters). Opt-in by the account's own per-user
//                      'nexum.crossMapSync' setting, and only when the account
//                      itself makes the edit: someone the map is shared with
//                      can't push into the owner's other maps.
//   - corp map      -> that corp's other corp maps,
//   - alliance map  -> that alliance's other alliance maps,
//                      both opted in per map (maps.cross_map_sync, set by
//                      admins). Source and target must BOTH be opted in.
//
// Fire-and-forget -- it must never block or fail the originating edit. Writes
// go straight to the sibling rows (not back through the route handlers), so
// there's no propagation loop; sibling maps get a sig.changed / anom.changed
// broadcast so live viewers refresh.

async function userSyncEnabled(userId: number): Promise<boolean> {
  const { rows } = await db.query<{ v: string | null }>(
    `SELECT ui_settings->>'nexum.crossMapSync' AS v FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.v === 'true';
}

interface SourceScope {
  eveSystemId: number | null;
  userId: number | null;
  ownerId: number | null;
  corpId: number | null;
  allianceId: number | null;
  mapSync: boolean;
}

async function sourceScope(systemId: string): Promise<SourceScope | null> {
  const { rows } = await db.query<{
    eve_system_id: number | null; user_id: number | null; owner_id: number | null;
    corp_id: number | null; alliance_id: number | null; cross_map_sync: boolean;
  }>(
    `SELECT ms.eve_system_id, m.user_id, m.owner_id, m.corp_id, m.alliance_id, m.cross_map_sync
     FROM map_systems ms JOIN maps m ON m.id = ms.map_id
     WHERE ms.id = $1`,
    [systemId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    eveSystemId: r.eve_system_id, userId: r.user_id, ownerId: r.owner_id,
    corpId: r.corp_id, allianceId: r.alliance_id, mapSync: r.cross_map_sync,
  };
}

// Does this edit propagate at all? Org maps: the map's own switch. Personal
// maps: the editor's setting, and the editor must belong to the owning account.
async function editPropagates(scope: SourceScope, editorUserId: number): Promise<boolean> {
  if (scope.allianceId !== null || scope.corpId !== null) return scope.mapSync;
  if (!(await userSyncEnabled(editorUserId))) return false;
  if (scope.userId === editorUserId) return true;
  if (scope.ownerId === null) return false;
  const { rows } = await db.query<{ owner_id: number | null }>(
    `SELECT owner_id FROM users WHERE id = $1`,
    [editorUserId],
  );
  return rows[0]?.owner_id === scope.ownerId;
}

// Sibling systems = same EVE system on other maps in the same scope.
async function siblingSystems(mapId: string, scope: SourceScope): Promise<{ systemId: string; mapId: string }[]> {
  if (scope.eveSystemId == null) return []; // custom system -- no cross-map identity
  let where: string;
  let scopeVals: unknown[];
  if (scope.allianceId !== null) {
    where = 'm.alliance_id = $3 AND m.cross_map_sync';
    scopeVals = [scope.allianceId];
  } else if (scope.corpId !== null) {
    where = 'm.corp_id = $3 AND m.alliance_id IS NULL AND m.cross_map_sync';
    scopeVals = [scope.corpId];
  } else {
    // Personal maps of the same account. Pre-multi-account maps may have no
    // owner yet, so fall back to the creating character for those.
    where = `m.corp_id IS NULL AND m.alliance_id IS NULL
             AND (($3::int IS NOT NULL AND m.owner_id = $3) OR ($3::int IS NULL AND m.user_id = $4))`;
    scopeVals = [scope.ownerId, scope.userId];
  }
  const { rows } = await db.query<{ system_id: string; map_id: string }>(
    `SELECT ms.id AS system_id, ms.map_id
     FROM map_systems ms JOIN maps m ON m.id = ms.map_id
     WHERE ms.eve_system_id = $1
       AND ms.map_id <> $2
       AND ${where}`,
    [scope.eveSystemId, mapId, ...scopeVals],
  );
  return rows.map((r) => ({ systemId: r.system_id, mapId: r.map_id }));
}

/** Where an edit by `editorUserId` to `systemId` on `mapId` should be copied.
 *  Empty when sync is off for this edit. Exported for tests. */
export async function syncTargets(
  mapId: string, systemId: string, editorUserId: number,
): Promise<{ systemId: string; mapId: string }[]> {
  const scope = await sourceScope(systemId);
  if (!scope || !(await editPropagates(scope, editorUserId))) return [];
  return siblingSystems(mapId, scope);
}

// ── Signatures ────────────────────────────────────────────────────────────────

interface SigRow {
  sig_id: string; sig_type: string; name: string; notes: string; wh_type: string; wh_leads_to: string;
  ghost_type: string;
}

async function upsertSigToSibling(sibSystemId: string, sibMapId: string, sig: SigRow, userId: number): Promise<void> {
  const { rows } = await db.query<{ id: string } & SigRow>(
    `SELECT id, sig_type, name, notes, wh_type, wh_leads_to, ghost_type
     FROM map_signatures WHERE system_id = $1 AND UPPER(sig_id) = UPPER($2)`,
    [sibSystemId, sig.sig_id],
  );
  const existing = rows[0];
  if (existing) {
    // Fill blanks only — never clobber data already entered on the sibling.
    const sets: string[] = [];
    const vals: unknown[] = [];
    const fill = (col: string, cur: string, next: string, empty = '') => {
      if ((cur === empty || cur == null) && next && next !== empty) {
        sets.push(`${col} = $${vals.length + 1}`); vals.push(next);
      }
    };
    fill('sig_type', existing.sig_type, sig.sig_type, 'unknown');
    fill('name', existing.name, sig.name);
    fill('notes', existing.notes, sig.notes);
    fill('wh_type', existing.wh_type, sig.wh_type);
    fill('wh_leads_to', existing.wh_leads_to, sig.wh_leads_to);
    fill('ghost_type', existing.ghost_type, sig.ghost_type);
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');
    await db.query(`UPDATE map_signatures SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, existing.id]);
  } else {
    // New on this sibling. from_merge = TRUE so it doesn't inflate scan stats.
    // DO NOTHING: someone may have added it there since the lookup above.
    await db.query(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to, ghost_type, created_by_user_id, from_merge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       ON CONFLICT (system_id, UPPER(sig_id)) WHERE sig_id <> '' DO NOTHING`,
      [sibSystemId, sig.sig_id, sig.sig_type, sig.name, sig.notes, sig.wh_type, sig.wh_leads_to, sig.ghost_type, userId],
    );
  }
  publishToMap(sibMapId, { type: 'sig.changed', actor: null, systemId: sibSystemId });
}

/** Fire-and-forget: propagate one signature (by its row id) to sibling maps. */
export function syncSignature(mapId: string, systemId: string, sigRowId: string, userId: number | undefined): void {
  if (!userId) return;
  void (async () => {
    const sibs = await syncTargets(mapId, systemId, userId);
    if (sibs.length === 0) return;
    const { rows } = await db.query<SigRow>(
      `SELECT sig_id, sig_type, name, notes, wh_type, wh_leads_to, ghost_type FROM map_signatures WHERE id = $1`,
      [sigRowId],
    );
    const sig = rows[0];
    if (!sig || !sig.sig_id) return; // blank sig id can't be matched across maps
    for (const s of sibs) await upsertSigToSibling(s.systemId, s.mapId, sig, userId);
  })().catch((err) => log.error('signature cross-map sync failed:', err));
}

// ── Anomalies ─────────────────────────────────────────────────────────────────

interface AnomRow { anom_id: string; anom_type: string; name: string; notes: string }

async function upsertAnomToSibling(sibSystemId: string, sibMapId: string, anom: AnomRow, userId: number): Promise<void> {
  const { rows } = await db.query<{ id: string } & AnomRow>(
    `SELECT id, anom_type, name, notes FROM map_anomalies WHERE system_id = $1 AND anom_id = $2`,
    [sibSystemId, anom.anom_id],
  );
  const existing = rows[0];
  if (existing) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const fill = (col: string, cur: string, next: string, empty = '') => {
      if ((cur === empty || cur == null) && next && next !== empty) {
        sets.push(`${col} = $${vals.length + 1}`); vals.push(next);
      }
    };
    fill('anom_type', existing.anom_type, anom.anom_type, 'unknown');
    fill('name', existing.name, anom.name);
    fill('notes', existing.notes, anom.notes);
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');
    await db.query(`UPDATE map_anomalies SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, existing.id]);
  } else {
    await db.query(
      `INSERT INTO map_anomalies (system_id, anom_id, anom_type, name, notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sibSystemId, anom.anom_id, anom.anom_type, anom.name, anom.notes, userId],
    );
  }
  publishToMap(sibMapId, { type: 'anom.changed', actor: null, systemId: sibSystemId });
}

/** Fire-and-forget: propagate one anomaly (by its row id) to sibling maps. */
export function syncAnomaly(mapId: string, systemId: string, anomRowId: string, userId: number | undefined): void {
  if (!userId) return;
  void (async () => {
    const sibs = await syncTargets(mapId, systemId, userId);
    if (sibs.length === 0) return;
    const { rows } = await db.query<AnomRow>(
      `SELECT anom_id, anom_type, name, notes FROM map_anomalies WHERE id = $1`,
      [anomRowId],
    );
    const anom = rows[0];
    if (!anom || !anom.anom_id) return;
    for (const s of sibs) await upsertAnomToSibling(s.systemId, s.mapId, anom, userId);
  })().catch((err) => log.error('anomaly cross-map sync failed:', err));
}
