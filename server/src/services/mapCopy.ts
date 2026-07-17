import crypto from 'node:crypto';
import { db } from '../db.js';

export interface CopyInclude {
  notes:      boolean;   // system notes (map_systems.notes)
  signatures: boolean;
  structures: boolean;
  anomalies:  boolean;
}

// Chunked multi-row insert — keeps each statement well under Postgres' 65535
// bound-parameter cap even for the largest maps.
async function insertBatch(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  table: string,
  cols: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((r) => {
      const base = values.length;
      values.push(...r);
      return `(${r.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`, values);
  }
}

/**
 * Duplicate `sourceMapId` into a brand-new map owned by `ownerId` / created by
 * `userId`. The copy's scope is set by `corpId` / `allianceId` (both null → a
 * personal map); the caller (the copy route) is responsible for the role,
 * affiliation and quota checks that scope requires. Systems + connections (with
 * per-system intel/labels/status/home) are always copied; `include` gates system
 * notes, signatures, structures and anomalies. Everything runs in one
 * transaction; the new map id is returned. Copied signatures are flagged
 * `from_merge` so they don't count as fresh scanning activity.
 */
export async function copyMap(params: {
  sourceMapId: string;
  name: string;
  ownerId: number | null;
  userId: number;
  corpId?: number | null;
  allianceId?: number | null;
  include: CopyInclude;
}): Promise<string> {
  const { sourceMapId, name, ownerId, userId, include } = params;
  const corpId     = params.corpId ?? null;
  const allianceId = params.allianceId ?? null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: mapRows } = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name, corp_id, alliance_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, ownerId, name, corpId, allianceId],
    );
    const newMapId = mapRows[0].id;

    // ── Systems (always) — build old→new id map for everything downstream ──
    const sysRes = await client.query<{
      id: string; eveSystemId: number | null; name: string; systemClass: string; effect: string;
      statics: string[]; regionName: string | null; npcType: string | null; x: number; y: number;
      status: string; isHome: boolean; locked: boolean; notes: string; intel: string | null;
      labels: string[]; customLabels: string[]; tag: string | null; alias: string | null;
    }>(
      `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass", effect, statics,
              region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y,
              status, is_home AS "isHome", locked, notes, intel, labels, custom_labels AS "customLabels", tag, alias
         FROM map_systems WHERE map_id = $1`,
      [sourceMapId],
    );
    const sysIdMap = new Map<string, string>();
    for (const s of sysRes.rows) sysIdMap.set(s.id, crypto.randomUUID());

    await insertBatch(client, 'map_systems',
      ['id', 'map_id', 'eve_system_id', 'name', 'system_class', 'effect', 'statics', 'region_name',
       'npc_type', 'position_x', 'position_y', 'status', 'is_home', 'locked', 'notes', 'intel',
       'labels', 'custom_labels', 'tag', 'alias'],
      sysRes.rows.map((s) => [
        sysIdMap.get(s.id), newMapId, s.eveSystemId, s.name, s.systemClass, s.effect, s.statics,
        s.regionName, s.npcType, s.x, s.y, s.status, s.isHome, s.locked,
        include.notes ? s.notes : '', s.intel, s.labels, s.customLabels, s.tag, s.alias,
      ]),
    );

    // ── Signatures (optional) — insert before connections so the connection
    // ↔ signature links can be remapped to the new sig ids ──────────────────
    const sigIdMap = new Map<string, string>();
    if (include.signatures) {
      const sigRes = await client.query<{
        id: string; systemId: string; sigId: string; sigType: string; name: string;
        notes: string; whType: string; whLeadsTo: string;
      }>(
        `SELECT id, system_id AS "systemId", sig_id AS "sigId", sig_type AS "sigType", name, notes,
                wh_type AS "whType", wh_leads_to AS "whLeadsTo"
           FROM map_signatures
          WHERE system_id = ANY($1::uuid[])`,
        [[...sysIdMap.keys()]],
      );
      for (const g of sigRes.rows) sigIdMap.set(g.id, crypto.randomUUID());
      await insertBatch(client, 'map_signatures',
        ['id', 'system_id', 'sig_id', 'sig_type', 'name', 'notes', 'wh_type', 'wh_leads_to',
         'created_by_user_id', 'from_merge'],
        sigRes.rows.map((g) => [
          sigIdMap.get(g.id), sysIdMap.get(g.systemId), g.sigId, g.sigType, g.name, g.notes,
          g.whType, g.whLeadsTo, userId, true,
        ]),
      );
    }

    // ── Connections (always) — remap endpoints + sig links ──────────────────
    const connRes = await client.query<{
      sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null;
      connectionType: string; massStatus: string | null; timeStatus: string | null; size: string;
      whType: string | null; massUsed: string; eolAt: Date | null; lifetimeExpiresAt: Date | null; broken: boolean;
      sourceSignatureId: string | null; targetSignatureId: string | null;
    }>(
      `SELECT source_id AS "sourceId", target_id AS "targetId", source_handle AS "sourceHandle",
              target_handle AS "targetHandle", connection_type AS "connectionType",
              mass_status AS "massStatus", time_status AS "timeStatus", size, wh_type AS "whType",
              mass_used AS "massUsed", eol_at AS "eolAt", lifetime_expires_at AS "lifetimeExpiresAt", broken,
              source_signature_id AS "sourceSignatureId", target_signature_id AS "targetSignatureId"
         FROM map_connections WHERE map_id = $1`,
      [sourceMapId],
    );
    const remapSig = (id: string | null) => (id ? sigIdMap.get(id) ?? null : null);
    await insertBatch(client, 'map_connections',
      ['id', 'map_id', 'source_id', 'target_id', 'source_handle', 'target_handle', 'connection_type',
       'mass_status', 'time_status', 'size', 'wh_type', 'mass_used', 'eol_at', 'lifetime_expires_at', 'broken',
       'source_signature_id', 'target_signature_id'],
      connRes.rows.flatMap((c): unknown[][] => {
        const src = sysIdMap.get(c.sourceId);
        const tgt = sysIdMap.get(c.targetId);
        if (!src || !tgt) return [];
        return [[
          crypto.randomUUID(), newMapId, src, tgt, c.sourceHandle, c.targetHandle, c.connectionType,
          c.massStatus, c.timeStatus, c.size, c.whType, c.massUsed, c.eolAt, c.lifetimeExpiresAt, c.broken,
          remapSig(c.sourceSignatureId), remapSig(c.targetSignatureId),
        ]];
      }),
    );

    // ── Structures (optional) ───────────────────────────────────────────────
    if (include.structures) {
      const stRes = await client.query<{
        systemId: string; name: string; structureType: string; ownerCorp: string;
        eveId: string | null; notes: string; ownerCorpId: number | null;
      }>(
        `SELECT system_id AS "systemId", name, structure_type AS "structureType", owner_corp AS "ownerCorp",
                eve_id AS "eveId", notes, owner_corp_id AS "ownerCorpId"
           FROM map_structures WHERE system_id = ANY($1::uuid[])`,
        [[...sysIdMap.keys()]],
      );
      await insertBatch(client, 'map_structures',
        ['system_id', 'name', 'structure_type', 'owner_corp', 'eve_id', 'notes', 'created_by_user_id', 'owner_corp_id'],
        stRes.rows.map((st) => [
          sysIdMap.get(st.systemId), st.name, st.structureType, st.ownerCorp, st.eveId, st.notes, userId, st.ownerCorpId,
        ]),
      );
    }

    // ── Anomalies (optional) ────────────────────────────────────────────────
    if (include.anomalies) {
      const anRes = await client.query<{
        systemId: string; anomId: string; anomType: string; name: string; notes: string;
      }>(
        `SELECT system_id AS "systemId", anom_id AS "anomId", anom_type AS "anomType", name, notes
           FROM map_anomalies WHERE system_id = ANY($1::uuid[])`,
        [[...sysIdMap.keys()]],
      );
      await insertBatch(client, 'map_anomalies',
        ['system_id', 'anom_id', 'anom_type', 'name', 'notes', 'created_by_user_id'],
        anRes.rows.map((a) => [sysIdMap.get(a.systemId), a.anomId, a.anomType, a.name, a.notes, userId]),
      );
    }

    await client.query('COMMIT');
    return newMapId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
