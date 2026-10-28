import { db } from '../db.js';
import { publishToMap } from './mapEvents.js';
import { syncSignature, syncAnomaly } from './crossMapSync.js';
import { recordGhostSiteIfMatch } from './ghostSites.js';
import { createLogger } from '../utils/logger.js';
import { recordMapAudit, inSystemLabel, type AuditActor, type AuditEntry } from './mapAudit.js';

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
  /** Who to record in the map's audit log. Absent for writes nobody made by
   *  hand (cross-map sync, sweeps), which aren't audited. */
  audit?: AuditActor;
}

// Audit a content change, labelled by the item and the system it's in.
function audit(
  actor: WriteActor, mapId: string, systemId: string, item: string,
  entry: Omit<AuditEntry, 'subject'>,
): void {
  const who = actor.audit;
  if (!who) return;
  inSystemLabel(mapId, systemId, item)
    .then((subject) => recordMapAudit(who, mapId, { ...entry, subject }))
    .catch(console.error);
}

// How a signature or anomaly reads in the log: its scan id, else its name.
const scanLabel = (scanId: string | null | undefined, name: string | null | undefined) =>
  (scanId && scanId.trim()) || (name && name.trim()) || '';

const bumpActivity = (systemId: string) =>
  db.query(`UPDATE map_systems SET last_activity_at = NOW() WHERE id = $1`, [systemId]).catch(console.error);

// map_id scoping in the UPDATE/DELETE WHERE is defence-in-depth: the caller has
// already confirmed the system is in the map, but enforcing it in SQL too means
// a future refactor can't open a cross-map write.
const inThisMap = (n: number) => `system_id IN (SELECT id FROM map_systems WHERE map_id = $${n})`;

// ── Signatures ────────────────────────────────────────────────────────────────

export interface SignatureInput {
  sigId: string; sigType: string; name: string; notes: string; whType: string; whLeadsTo: string;
  ghostType: string;
  massStatus: string;
  timeStatus: string;
  /** Set only by the Thera/Turnur copy, to the eve-scout connection id this
   *  row came from. Null everywhere else, which is what lets the cleanup tell
   *  "we wrote this" from "a person wrote this". */
  scoutConnectionId?: string | null;
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

/** Thrown by updateSignature when the new scan id is already used by another
 *  signature in the same system. Routes answer it with a 409. */
export class DuplicateSignatureError extends Error {
  constructor() { super('A signature with that ID already exists in this system'); }
}

export async function createSignature(mapId: string, systemId: string, d: SignatureInput, actor: WriteActor) {
  logIfContentless(mapId, systemId, d, actor);
  // Returns the creator alongside the row. The client inserts this response
  // straight into the open pane, and without the character the "added by"
  // portrait stayed blank until something forced a re-fetch -- which looked
  // like the row had no author rather than like a missing field.
  // A CTE rather than a second round trip: the id is only known after the
  // insert, and the join is on a user we already have the id for.
  //
  // The scan id is unique per system (uq_map_signatures_system_sig), so a
  // create for an id that is already there -- two pilots pasting the same scan
  // a moment apart -- lands on the existing row instead, filling only its
  // empty fields (as a paste onto a known sig does) and leaving the author.
  // `inserted` tells the two apart; xmax is 0 only on a freshly inserted row.
  const { rows } = await db.query(
    `WITH ins AS (
       INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to, ghost_type, mass_status, time_status, created_by_user_id,
                                   scout_connection_id, scout_last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, CASE WHEN $12::text IS NULL THEN NULL ELSE NOW() END)
       ON CONFLICT (system_id, UPPER(sig_id)) WHERE sig_id <> '' DO UPDATE SET
         sig_type    = CASE WHEN map_signatures.sig_type    = 'unknown' THEN EXCLUDED.sig_type    ELSE map_signatures.sig_type    END,
         name        = CASE WHEN map_signatures.name        = ''        THEN EXCLUDED.name        ELSE map_signatures.name        END,
         notes       = CASE WHEN map_signatures.notes       = ''        THEN EXCLUDED.notes       ELSE map_signatures.notes       END,
         wh_type     = CASE WHEN map_signatures.wh_type     = ''        THEN EXCLUDED.wh_type     ELSE map_signatures.wh_type     END,
         wh_leads_to = CASE WHEN map_signatures.wh_leads_to = ''        THEN EXCLUDED.wh_leads_to ELSE map_signatures.wh_leads_to END,
         ghost_type  = CASE WHEN map_signatures.ghost_type  = ''        THEN EXCLUDED.ghost_type  ELSE map_signatures.ghost_type  END,
         mass_status = CASE WHEN map_signatures.mass_status = ''        THEN EXCLUDED.mass_status ELSE map_signatures.mass_status END,
         time_status = CASE WHEN map_signatures.time_status = ''        THEN EXCLUDED.time_status ELSE map_signatures.time_status END,
         updated_at  = NOW()
       RETURNING *, (xmax = 0) AS inserted
     )
     SELECT ins.inserted, ins.id, ins.sig_id AS "sigId", ins.sig_type AS "sigType", ins.name, ins.notes,
            ins.wh_type AS "whType", ins.wh_leads_to AS "whLeadsTo",
            ins.ghost_type AS "ghostType", ins.mass_status AS "massStatus",
            ins.time_status AS "timeStatus", ins.created_at AS "createdAt",
            u.character_name AS "createdByName", u.character_id AS "createdByCharId"
       FROM ins LEFT JOIN users u ON u.id = ins.created_by_user_id`,
    [systemId, d.sigId, d.sigType, d.name, d.notes, d.whType, d.whLeadsTo, d.ghostType,
     d.massStatus, d.timeStatus, actor.userId, d.scoutConnectionId ?? null],
  );
  const { inserted, ...row } = rows[0] as { inserted: boolean } & Record<string, unknown> & { id: string };
  // Scan stats count signatures found, so a create that merged into an
  // existing row isn't another one.
  if (inserted) {
    db.query(`INSERT INTO user_events (user_id, event_type, sig_type) VALUES ($1, 'signature', $2)`,
      [actor.userId, d.sigType]).catch(console.error);
  }
  bumpActivity(systemId);
  recordGhostSiteIfMatch(systemId, d.name);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
  syncSignature(mapId, systemId, row.id, actor.userId);
  if (inserted) {
    audit(actor, mapId, systemId, scanLabel(d.sigId, d.name), {
      action: 'signature.add', targetId: row.id, details: { values: { sigType: d.sigType, whType: d.whType || undefined } },
    });
  }
  return { row, inserted };
}

// Signature fields whose new value goes in the audit entry (short codes);
// names and notes are listed by name only.
const AUDITED_SIG_VALUES = new Set(['sigId', 'sigType', 'whType', 'whLeadsTo', 'massStatus', 'timeStatus']);

const SIG_COLS: Record<string, string> = {
  sigId: 'sig_id', sigType: 'sig_type', name: 'name', notes: 'notes', whType: 'wh_type', whLeadsTo: 'wh_leads_to',
  ghostType: 'ghost_type', massStatus: 'mass_status', timeStatus: 'time_status',
  // Re-copying a hole that is still listed refreshes both, which is what keeps
  // the grace period meaningful: scout_last_seen is "the feed still had it".
  scoutConnectionId: 'scout_connection_id',
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
  // Writing the provenance also stamps when the feed last confirmed the hole.
  // Kept here rather than in SIG_COLS because the value is NOW(), not
  // something the caller supplies.
  if ('scoutConnectionId' in updates && updates.scoutConnectionId != null) {
    sets.push('scout_last_seen = NOW()');
  }
  let updated: { sigId: string; name: string }[];
  try {
    ({ rows: updated } = await db.query<{ sigId: string; name: string }>(
      `UPDATE map_signatures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}
       RETURNING sig_id AS "sigId", name`,
      [...vals, sigId, systemId, mapId],
    ));
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'uq_map_signatures_system_sig') throw new DuplicateSignatureError();
    throw err;
  }
  bumpActivity(systemId);
  if (typeof updates.name === 'string') recordGhostSiteIfMatch(systemId, updates.name);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
  syncSignature(mapId, systemId, sigId, actor.userId);
  const changed = Object.keys(updates).filter((k) => k in SIG_COLS && k !== 'scoutConnectionId');
  if (updated.length && changed.length) {
    const values: Record<string, unknown> = {};
    for (const k of changed) if (AUDITED_SIG_VALUES.has(k)) values[k] = updates[k];
    audit(actor, mapId, systemId, scanLabel(updated[0].sigId, updated[0].name), {
      action: 'signature.update', targetId: sigId, details: { fields: changed, values },
    });
  }
  return {
    dispatchK162: settingK162 && !prevWasK162,
    flushK162: typeof updates.whLeadsTo === 'string' && updates.whLeadsTo.trim().length > 0,
  };
}

export async function deleteSignature(mapId: string, systemId: string, sigId: string, actor: WriteActor): Promise<void> {
  const { rows } = await db.query<{ sigId: string; name: string }>(
    `DELETE FROM map_signatures WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)} RETURNING sig_id AS "sigId", name`,
    [sigId, systemId, mapId],
  );
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'sig.changed', actor: actor.clientId, systemId });
  if (rows.length) audit(actor, mapId, systemId, scanLabel(rows[0].sigId, rows[0].name), { action: 'signature.remove', targetId: sigId });
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
  audit(actor, mapId, systemId, scanLabel(d.anomId, d.name), { action: 'anomaly.add', targetId: rows[0].id });
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
  const { rows } = await db.query<{ anomId: string; name: string }>(
    `UPDATE map_anomalies SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}
     RETURNING anom_id AS "anomId", name`,
    [...vals, anomId, systemId, mapId],
  );
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'anom.changed', actor: actor.clientId, systemId });
  syncAnomaly(mapId, systemId, anomId, actor.userId);
  const changed = Object.keys(updates).filter((k) => k in ANOM_COLS);
  if (rows.length && changed.length) {
    audit(actor, mapId, systemId, scanLabel(rows[0].anomId, rows[0].name), {
      action: 'anomaly.update', targetId: anomId, details: { fields: changed },
    });
  }
}

export async function deleteAnomaly(mapId: string, systemId: string, anomId: string, actor: WriteActor): Promise<void> {
  const { rows } = await db.query<{ anomId: string; name: string }>(
    `DELETE FROM map_anomalies WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)} RETURNING anom_id AS "anomId", name`,
    [anomId, systemId, mapId],
  );
  bumpActivity(systemId);
  publishToMap(mapId, { type: 'anom.changed', actor: actor.clientId, systemId });
  if (rows.length) audit(actor, mapId, systemId, scanLabel(rows[0].anomId, rows[0].name), { action: 'anomaly.remove', targetId: anomId });
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
  audit(actor, mapId, systemId, d.name || d.structureType, { action: 'structure.add', targetId: rows[0].id });
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
  const { rows } = await db.query<{ name: string; structureType: string }>(
    `UPDATE map_structures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2} AND ${inThisMap(vals.length + 3)}
     RETURNING name, structure_type AS "structureType"`,
    [...vals, structureId, systemId, mapId],
  );
  publishToMap(mapId, { type: 'structure.changed', actor: actor.clientId, systemId });
  const changed = Object.keys(updates).filter((k) => k in STRUCT_COLS);
  if (rows.length && changed.length) {
    audit(actor, mapId, systemId, rows[0].name || rows[0].structureType, {
      action: 'structure.update', targetId: structureId, details: { fields: changed },
    });
  }
}

export async function deleteStructure(mapId: string, systemId: string, structureId: string, actor: WriteActor): Promise<void> {
  const { rows } = await db.query<{ name: string; structureType: string }>(
    `DELETE FROM map_structures WHERE id = $1 AND system_id = $2 AND ${inThisMap(3)} RETURNING name, structure_type AS "structureType"`,
    [structureId, systemId, mapId],
  );
  publishToMap(mapId, { type: 'structure.changed', actor: actor.clientId, systemId });
  if (rows.length) audit(actor, mapId, systemId, rows[0].name || rows[0].structureType, { action: 'structure.remove', targetId: structureId });
}
