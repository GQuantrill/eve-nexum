import { db } from '../db.js';
import { publishToMap } from './mapEvents.js';
import { syncSignature, syncAnomaly } from './crossMapSync.js';
import { recordGhostSiteIfMatch } from './ghostSites.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('map-write');

// Shared per-system CONTENT writes (signatures, anomalies, structures) — the
// single source of truth behind both the cookie map routes and the external
// /api/v1 write routes. The CALLER access-checks the map (requireMapContentWrite)
// and verifies the system belongs to it first; these run the DB write plus the
// same side effects (activity bump, cross-map sync, ghost-site recording, SSE
// broadcast). K162 Discord dispatch and ESI structure-owner resolution stay in
// the route layer — they need the MapMeta / a blocking ESI call — so each
// signature/structure function returns just enough for the route to drive them.

export interface WriteActor {
  /** users.id of the acting character — created_by, activity stats, sync owner. */
  userId: number;
  /** x-client-id for SSE echo suppression (null for API-key writes). */
  clientId: string | null;
}

const bumpActivity = (systemId: string) =>
  db.query(`UPDATE map_systems SET last_activity_at = NOW() WHERE id = $1`, [systemId]).catch(console.error);

// map_id scoping in the UPDATE/DELETE WHERE is defence-in-depth: the caller has
// already confirmed the system is in the map, but enforcing it in SQL too means
// a future refactor can't open a cross-map write.
const inThisMap = (n: number) => `system_id IN (SELECT id FROM map_systems WHERE map_id = $${n})`;

// ── Signatures ────────────────────────────────────────────────────────────────

export interface SignatureInput {
  sigId: string; sigType: string; name: string; notes: string; whType: string; whLeadsTo: string;
}

// A signature carrying nothing at all — no scan id, no name, no notes, no
// wormhole data. "Add signature" legitimately creates one (an empty row to type
// into), but they have also been appearing on live maps that nobody added by
// hand, so log every one with the actor and client that asked for it. clientId
// is the browser tab's x-client-id and is null for API-key writes, which
// separates the app from an integration. Diagnostic — remove once the source of
// the unexplained ones is identified.
function logIfContentless(mapId: string, systemId: string, d: SignatureInput, actor: WriteActor): void {
  if (d.sigId || d.name || d.notes || d.whType || d.whLeadsTo) return;
  log.warn('contentless signature created', JSON.stringify({
    mapId, systemId, sigType: d.sigType, userId: actor.userId, clientId: actor.clientId,
  }));
}

export async function createSignature(mapId: string, systemId: string, d: SignatureInput, actor: WriteActor) {
  logIfContentless(mapId, systemId, d, actor);
  const { rows } = await db.query(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, sig_id AS "sigId", sig_type AS "sigType", name, notes, wh_type AS "whType", wh_leads_to AS "whLeadsTo", created_at AS "createdAt"`,
    [systemId, d.sigId, d.sigType, d.name, d.notes, d.whType, d.whLeadsTo, actor.userId],
  );
  db.query(`INSERT INTO user_events (user_id, event_type, sig_type) VALUES ($1, 'signature', $2)`,
    [actor.userId, d.sigType]).catch(console.error);
  bumpActivity(systemId);
  recordGhostSiteIfMatch(systemId, d.name);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
  syncSignature(mapId, systemId, rows[0].id, actor.userId);
  return rows[0];
}

const SIG_COLS: Record<string, string> = {
  sigId: 'sig_id', sigType: 'sig_type', name: 'name', notes: 'notes', whType: 'wh_type', whLeadsTo: 'wh_leads_to',
};

// Updates the signature and returns flags the route uses to drive the K162
// Discord notice: dispatchK162 fires once on a transition *into* K162;
// flushK162 sends any pending notice now that the leads-to is known.
export async function updateSignature(
  mapId: string, systemId: string, sigId: string, updates: Record<string, unknown>, actor: WriteActor,
): Promise<{ dispatchK162: boolean; flushK162: boolean }> {
  const settingK162 = typeof updates.whType === 'string' && updates.whType.toUpperCase() === 'K162';
  let prevWasK162 = false;
  if (settingK162) {
    const { rows: prev } = await db.query<{ wh_type: string | null }>(
      `SELECT wh_type FROM map_signatures WHERE id = $1 AND system_id = $2`, [sigId, systemId]);
    prevWasK162 = (prev[0]?.wh_type ?? '').toUpperCase() === 'K162';
  }

  // The other way a blank row can appear: an existing signature's scan id being
  // cleared. Only the ID input writes this, on every keystroke, so a legitimate
  // retype logs one line — worth the noise while the unexplained blanks are
  // being traced. Diagnostic, paired with logIfContentless above.
  if ('sigId' in updates && !updates.sigId) {
    log.warn('signature scan id cleared', JSON.stringify({
      mapId, systemId, sigRowId: sigId, userId: actor.userId, clientId: actor.clientId,
    }));
  }

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(SIG_COLS)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }
  await db.query(
    `UPDATE map_signatures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}`,
    [...vals, sigId, systemId, mapId],
  );
  bumpActivity(systemId);
  if (typeof updates.name === 'string') recordGhostSiteIfMatch(systemId, updates.name);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
  syncSignature(mapId, systemId, sigId, actor.userId);
  return {
    dispatchK162: settingK162 && !prevWasK162,
    flushK162: typeof updates.whLeadsTo === 'string' && updates.whLeadsTo.trim().length > 0,
  };
}

export async function deleteSignature(mapId: string, systemId: string, sigId: string, actor: WriteActor): Promise<void> {
  await db.query(`DELETE FROM map_signatures WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)}`, [sigId, systemId, mapId]);
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
}

// ── Anomalies ─────────────────────────────────────────────────────────────────

export interface AnomalyInput { anomId: string; anomType: string; name: string; notes: string; }

export async function createAnomaly(mapId: string, systemId: string, d: AnomalyInput, actor: WriteActor) {
  const { rows } = await db.query(
    `INSERT INTO map_anomalies (system_id, anom_id, anom_type, name, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, anom_id AS "anomId", anom_type AS "anomType", name, notes, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [systemId, d.anomId, d.anomType, d.name, d.notes, actor.userId],
  );
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'anom.changed', actor: actor.clientId, systemId });
  syncAnomaly(mapId, systemId, rows[0].id, actor.userId);
  return rows[0];
}

const ANOM_COLS: Record<string, string> = { anomId: 'anom_id', anomType: 'anom_type', name: 'name', notes: 'notes' };

export async function updateAnomaly(
  mapId: string, systemId: string, anomId: string, updates: Record<string, unknown>, actor: WriteActor,
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(ANOM_COLS)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }
  await db.query(
    `UPDATE map_anomalies SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}`,
    [...vals, anomId, systemId, mapId],
  );
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'anom.changed', actor: actor.clientId, systemId });
  syncAnomaly(mapId, systemId, anomId, actor.userId);
}

export async function deleteAnomaly(mapId: string, systemId: string, anomId: string, actor: WriteActor): Promise<void> {
  await db.query(`DELETE FROM map_anomalies WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)}`, [anomId, systemId, mapId]);
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'anom.changed', actor: actor.clientId, systemId });
}

// ── Structures ────────────────────────────────────────────────────────────────
// No activity bump and no cross-map sync — structures don't back staleness or
// sync (mirrors the cookie routes).

export interface StructureInput {
  name: string; structureType: string; ownerCorp: string; notes: string;
  eveId: number | null; ownerCorpId: number | null;
}

export async function createStructure(mapId: string, systemId: string, d: StructureInput, actor: WriteActor) {
  const { rows } = await db.query(
    `INSERT INTO map_structures (system_id, name, structure_type, owner_corp, eve_id, notes, created_by_user_id, owner_corp_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, structure_type AS "structureType", owner_corp AS "ownerCorp", eve_id AS "eveId", notes, created_at AS "createdAt", owner_corp_id AS "ownerCorpId"`,
    [systemId, d.name, d.structureType, d.ownerCorp, d.eveId, d.notes, actor.userId, d.ownerCorpId],
  );
  publishToMap(mapId, { type: 'structure.changed', actor: actor.clientId, systemId });
  return rows[0];
}

const STRUCT_COLS: Record<string, string> = {
  name: 'name', structureType: 'structure_type', ownerCorp: 'owner_corp', eveId: 'eve_id', notes: 'notes',
};

export async function updateStructure(
  mapId: string, systemId: string, structureId: string, updates: Record<string, unknown>, actor: WriteActor,
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(STRUCT_COLS)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }
  await db.query(
    `UPDATE map_structures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}`,
    [...vals, structureId, systemId, mapId],
  );
  publishToMap(mapId, { type: 'structure.changed', actor: actor.clientId, systemId });
}

export async function deleteStructure(mapId: string, systemId: string, structureId: string, actor: WriteActor): Promise<void> {
  await db.query(`DELETE FROM map_structures WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)}`, [structureId, systemId, mapId]);
  publishToMap(mapId, { type: 'structure.changed', actor: actor.clientId, systemId });
}
