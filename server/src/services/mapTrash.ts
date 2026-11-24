import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { CONNECTION_COLS } from './mapRead.js';
import { RESERVATION_HOURS } from './chainNumber.js';

// Recently deleted systems and connections.
//
// Deleting a system deletes, by cascade, its signatures, anomalies, structures,
// its connections and their jump logs. Undo used to re-create only what the
// browser had drawn (the system and its lines), so everything else was lost.
// Now the delete keeps a copy of all of it here for an hour, and undo restores
// that copy: same ids, same rows.
//
// Rows are copied whole (to_jsonb) and put back with jsonb_populate_recordset,
// so a column added to any of these tables later is carried without changes
// here.

export const TRASH_KEEP = '1 hour';

type Row = Record<string, unknown>;

interface SystemPayload {
  system: Row;
  signatures: Row[];
  anomalies: Row[];
  structures: Row[];
  connections: Row[];
  jumps: Row[];
}

interface ConnectionPayload {
  connection: Row;
  jumps: Row[];
}

async function rows(client: PoolClient, sql: string, params: unknown[]): Promise<Row[]> {
  const r = await client.query<{ j: Row }>(sql, params);
  return r.rows.map((x) => x.j);
}

async function save(
  client: PoolClient, mapId: string, kind: 'system' | 'connection', targetId: string,
  userId: number | null, payload: SystemPayload | ConnectionPayload,
): Promise<void> {
  await client.query(`DELETE FROM map_trash WHERE deleted_at < NOW() - $1::interval`, [TRASH_KEEP]);
  await client.query(
    `INSERT INTO map_trash (map_id, kind, target_id, deleted_by, payload) VALUES ($1, $2, $3, $4, $5)`,
    [mapId, kind, targetId, userId, JSON.stringify(payload)],
  );
}

/** Copy a system and everything that goes with it into the trash. Call inside
 *  the transaction that deletes it, before the delete. False if it isn't on
 *  this map. */
export async function trashSystem(
  client: PoolClient, mapId: string, systemId: string, userId: number | null,
): Promise<boolean> {
  const [system] = await rows(client,
    `SELECT to_jsonb(s) AS j FROM map_systems s WHERE s.id = $1 AND s.map_id = $2`, [systemId, mapId]);
  if (!system) return false;
  const bySystem = (table: string) => rows(client,
    `SELECT to_jsonb(t) AS j FROM ${table} t WHERE t.system_id = $1`, [systemId]);
  const payload: SystemPayload = {
    system,
    signatures: await bySystem('map_signatures'),
    anomalies:  await bySystem('map_anomalies'),
    structures: await bySystem('map_structures'),
    connections: await rows(client,
      `SELECT to_jsonb(c) AS j FROM map_connections c
        WHERE c.map_id = $1 AND (c.source_id = $2 OR c.target_id = $2)`, [mapId, systemId]),
    jumps: await rows(client,
      `SELECT to_jsonb(j) AS j FROM map_connection_jumps j
         JOIN map_connections c ON c.id = j.connection_id
        WHERE c.map_id = $1 AND (c.source_id = $2 OR c.target_id = $2)`, [mapId, systemId]),
  };
  await save(client, mapId, 'system', systemId, userId, payload);
  return true;
}

/** Copy a connection and its jump log into the trash, before deleting it. */
export async function trashConnection(
  client: PoolClient, mapId: string, connectionId: string, userId: number | null,
): Promise<boolean> {
  const [connection] = await rows(client,
    `SELECT to_jsonb(c) AS j FROM map_connections c WHERE c.id = $1 AND c.map_id = $2`, [connectionId, mapId]);
  if (!connection) return false;
  const jumps = await rows(client,
    `SELECT to_jsonb(j) AS j FROM map_connection_jumps j WHERE j.connection_id = $1`, [connectionId]);
  await save(client, mapId, 'connection', connectionId, userId, { connection, jumps });
  return true;
}

// The newest copy of this deletion, only for the pilot who made it (undo is
// theirs), only on this map, and only while it's kept.
async function take(client: PoolClient, mapId: string, kind: string, targetId: string, userId: number) {
  const { rows: found } = await client.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM map_trash
      WHERE map_id = $1 AND kind = $2 AND target_id = $3 AND deleted_by = $4
        AND deleted_at >= NOW() - $5::interval
      ORDER BY deleted_at DESC LIMIT 1
      FOR UPDATE`,
    [mapId, kind, targetId, userId, TRASH_KEEP],
  );
  if (!found.length) return null;
  await client.query(`DELETE FROM map_trash WHERE id = $1`, [found[0].id]);
  return found[0].payload;
}

async function insertRows(client: PoolClient, table: string, list: Row[]): Promise<number> {
  if (!list.length) return 0;
  // Any clash (the id, or a sig id already in that system) skips that row.
  const r = await client.query(
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(list)],
  );
  return r.rowCount ?? 0;
}

// Connections whose ends are both on the map (after any remap), that don't
// duplicate a link already there, with signature links dropped when that
// signature didn't come back. Returns the ids put back.
async function restoreConnections(
  client: PoolClient, mapId: string, list: Row[], jumps: Row[], remap: (id: string) => string,
): Promise<string[]> {
  if (!list.length) return [];
  const { rows: sysRows } = await client.query<{ id: string }>(
    `SELECT id FROM map_systems WHERE map_id = $1`, [mapId]);
  const onMap = new Set(sysRows.map((r) => r.id));
  const { rows: existing } = await client.query<{ s: string; t: string }>(
    `SELECT source_id AS s, target_id AS t FROM map_connections WHERE map_id = $1`, [mapId]);
  const pairs = new Set(existing.map((e) => [e.s, e.t].sort().join('|')));
  const sigIds = list.flatMap((c) => [c.source_signature_id, c.target_signature_id])
    .filter((v): v is string => typeof v === 'string');
  const { rows: sigRows } = sigIds.length
    ? await client.query<{ id: string }>(`SELECT id FROM map_signatures WHERE id = ANY($1::uuid[])`, [sigIds])
    : { rows: [] as { id: string }[] };
  const sigsBack = new Set(sigRows.map((r) => r.id));

  const keep: Row[] = [];
  for (const c of list) {
    const s = remap(String(c.source_id));
    const t = remap(String(c.target_id));
    if (s === t || !onMap.has(s) || !onMap.has(t)) continue;
    const pair = [s, t].sort().join('|');
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    keep.push({
      ...c, map_id: mapId, source_id: s, target_id: t,
      source_signature_id: sigsBack.has(String(c.source_signature_id)) ? c.source_signature_id : null,
      target_signature_id: sigsBack.has(String(c.target_signature_id)) ? c.target_signature_id : null,
    });
  }
  await insertRows(client, 'map_connections', keep);
  const ids = keep.map((c) => String(c.id));
  const { rows: back } = ids.length
    ? await client.query<{ id: string }>(`SELECT id FROM map_connections WHERE id = ANY($1::uuid[]) AND map_id = $2`, [ids, mapId])
    : { rows: [] as { id: string }[] };
  const backIds = new Set(back.map((r) => r.id));
  await insertRows(client, 'map_connection_jumps',
    jumps.filter((j) => backIds.has(String(j.connection_id))).map((j) => ({ ...j, map_id: mapId })));
  return [...backIds];
}

export interface RestoredSystem {
  /** The system now holding what was restored: the original id, or the id of
   *  the same system when someone put it back on the map in the meantime. */
  systemId: string;
  system: Record<string, unknown> | null;
  connections: Record<string, unknown>[];
}

async function canonicalSystem(client: PoolClient, mapId: string, id: string) {
  const { rows: r } = await client.query(
    `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass", effect, statics,
            region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y,
            status, intel, is_home AS "isHome", locked, notes,
            labels, custom_labels AS "customLabels", tag, alias, chain_label AS "chainLabel",
            (SELECT ss.security::float8 FROM solar_systems ss WHERE ss.id = map_systems.eve_system_id) AS "security",
            last_activity_at AS "lastActivityAt"
       FROM map_systems WHERE id = $1 AND map_id = $2`,
    [id, mapId],
  );
  if (!r.length) return null;
  const { x, y, ...rest } = r[0] as { x: number; y: number } & Record<string, unknown>;
  return { ...rest, position: { x, y } };
}

async function canonicalConnections(client: PoolClient, mapId: string, ids: string[]) {
  if (!ids.length) return [];
  const { rows: r } = await client.query(
    `SELECT ${CONNECTION_COLS} FROM map_connections WHERE map_id = $1 AND id = ANY($2::uuid[])`, [mapId, ids]);
  return r as Record<string, unknown>[];
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A chain number frees up once its system is gone (services/chainNumber.ts),
 *  so while a system was in the trash its number, or one reserved on its
 *  signatures, may have gone to another. The one put back loses it then, so
 *  no two holes share a number. */
async function dropReusedChainNumbers(client: PoolClient, mapId: string, systemId: string): Promise<void> {
  await client.query(
    `UPDATE map_systems y SET chain_label = NULL
      WHERE y.id = $2 AND y.chain_label IS NOT NULL
        AND EXISTS (SELECT 1 FROM map_systems z
                     WHERE z.map_id = $1 AND z.id <> y.id AND z.chain_label = y.chain_label)`,
    [mapId, systemId]);
  await client.query(
    `UPDATE map_signatures s SET chain_label = NULL, chain_reserved_at = NULL
      WHERE s.system_id = $2 AND s.chain_label IS NOT NULL
        AND (EXISTS (SELECT 1 FROM map_signatures t JOIN map_systems ty ON ty.id = t.system_id
                      WHERE ty.map_id = $1 AND t.id <> s.id AND t.chain_label = s.chain_label
                        AND t.chain_reserved_at > NOW() - interval '${RESERVATION_HOURS} hours')
          OR EXISTS (SELECT 1 FROM map_systems z
                      WHERE z.map_id = $1 AND z.chain_label = s.chain_label
                        AND upper(trim(z.name)) IS DISTINCT FROM upper(trim(s.wh_leads_to))))`,
    [mapId, systemId]);
}

/** Put a deleted system back with everything that went with it. Null when
 *  there's nothing to restore (expired, or not this pilot's deletion). */
export function restoreSystem(mapId: string, systemId: string, userId: number): Promise<RestoredSystem | null> {
  return inTransaction(async (client) => {
    const payload = await take(client, mapId, 'system', systemId, userId) as SystemPayload | null;
    if (!payload) return null;

    // Back on the map already (someone flew back in, or it was re-added by
    // hand)? Restore into that one instead of making a second copy.
    let target = systemId;
    const eveId = payload.system.eve_system_id;
    const { rows: same } = await client.query<{ id: string }>(
      `SELECT id FROM map_systems WHERE map_id = $1 AND (id = $2 OR (eve_system_id IS NOT NULL AND eve_system_id = $3))`,
      [mapId, systemId, eveId ?? null],
    );
    if (same.length) target = same[0].id;
    else await insertRows(client, 'map_systems', [{ ...payload.system, map_id: mapId }]);

    const move = (r: Row) => ({ ...r, system_id: target });
    await insertRows(client, 'map_signatures', payload.signatures.map(move));
    await insertRows(client, 'map_anomalies', payload.anomalies.map(move));
    await insertRows(client, 'map_structures', payload.structures.map(move));
    const connIds = await restoreConnections(client, mapId, payload.connections, payload.jumps,
      (id) => (id === systemId ? target : id));
    await dropReusedChainNumbers(client, mapId, target);

    return {
      systemId: target,
      system: await canonicalSystem(client, mapId, target),
      connections: await canonicalConnections(client, mapId, connIds),
    };
  });
}

/** Put a deleted connection back with its jump log. Null when there's nothing
 *  to restore; an empty list when its ends are gone or it's already there. */
export function restoreConnection(
  mapId: string, connectionId: string, userId: number,
): Promise<Record<string, unknown>[] | null> {
  return inTransaction(async (client) => {
    const payload = await take(client, mapId, 'connection', connectionId, userId) as ConnectionPayload | null;
    if (!payload) return null;
    const ids = await restoreConnections(client, mapId, [payload.connection], payload.jumps, (id) => id);
    return canonicalConnections(client, mapId, ids);
  });
}
