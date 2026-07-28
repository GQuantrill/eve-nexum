import { db } from '../db.js';

// Jump-log data access. A jump is one recorded crossing of a wormhole
// connection by a known pilot. This is READ-ONLY intel — nothing here ever
// touches map_connections.mass_used (the rolling calculator owns that). Ship
// name / class / base mass are resolved from the SDE by type id server-side, so
// a client can't forge a mass; the pilot identity is derived from the session /
// an owned character by the caller, never from the request body.

export interface JumpRow {
  id:             string;
  connectionId:   string;
  direction:      'forward' | 'reverse';
  fromEveSystemId: number | null;
  toEveSystemId:   number | null;
  fromSystemName:  string | null;
  toSystemName:    string | null;
  characterId:    number | null;
  characterName:  string | null;
  shipTypeId:     number | null;
  shipTypeName:   string | null;
  shipGroup:      string | null;   // ship class, e.g. "Battleship"
  shipMass:       number | null;   // base SDE mass, kg
  jumpedAt:       number;          // epoch ms
}

const SELECT_COLS = `
  id,
  connection_id  AS "connectionId",
  direction,
  from_eve_system_id AS "fromEveSystemId",
  to_eve_system_id   AS "toEveSystemId",
  from_system_name   AS "fromSystemName",
  to_system_name     AS "toSystemName",
  character_id   AS "characterId",
  character_name AS "characterName",
  ship_type_id   AS "shipTypeId",
  ship_type_name AS "shipTypeName",
  ship_group     AS "shipGroup",
  ship_mass::float8 AS "shipMass",
  (EXTRACT(EPOCH FROM jumped_at) * 1000)::float8 AS "jumpedAt"
`;

// Newest-first jump log for one connection. Bounded so a busy hole can't return
// an unbounded list — the recent crossings are what matter for eyeballing mass.
export async function listConnectionJumps(connectionId: string, limit = 100): Promise<JumpRow[]> {
  const { rows } = await db.query<JumpRow>(
    `SELECT ${SELECT_COLS} FROM map_connection_jumps
      WHERE connection_id = $1
      ORDER BY jumped_at DESC
      LIMIT $2`,
    [connectionId, limit],
  );
  return rows;
}

export interface RecordJumpInput {
  mapId:           string;
  connectionId:    string;
  direction:       'forward' | 'reverse';
  fromEveSystemId: number | null;
  toEveSystemId:   number | null;
  characterId:     number | null;
  characterName:   string | null;
  shipTypeId:      number | null;
}

// Insert one crossing, resolving the ship's name / class / base mass from the
// SDE (item_types + item_groups) by type id, and the from/to system names from
// solar_systems by id (both authoritative — never client-trusted). Returns the
// created row, ready to broadcast. Ids we can't resolve still record (with null
// display fields) so the pilot / order is never lost.
export async function recordConnectionJump(input: RecordJumpInput): Promise<JumpRow> {
  let typeName: string | null = null;
  let group:    string | null = null;
  let massKg:   number | null = null;

  if (input.shipTypeId != null) {
    const { rows } = await db.query<{ name: string; mass: string | null; groupName: string | null }>(
      `SELECT t.name, t.mass, g.name AS "groupName"
         FROM item_types t
         LEFT JOIN item_groups g ON g.id = t.group_id
        WHERE t.id = $1`,
      [input.shipTypeId],
    );
    if (rows.length) {
      typeName = rows[0].name ?? null;
      group    = rows[0].groupName ?? null;
      const m  = rows[0].mass == null ? null : Number(rows[0].mass);
      massKg   = m != null && Number.isFinite(m) ? Math.round(m) : null;
    }
  }

  // Resolve both system names in one query (authoritative SDE names).
  let fromName: string | null = null;
  let toName:   string | null = null;
  const sysIds = [input.fromEveSystemId, input.toEveSystemId].filter((x): x is number => x != null);
  if (sysIds.length) {
    const { rows } = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM solar_systems WHERE id = ANY($1::int[])`, [sysIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    fromName = input.fromEveSystemId != null ? byId.get(input.fromEveSystemId) ?? null : null;
    toName   = input.toEveSystemId   != null ? byId.get(input.toEveSystemId)   ?? null : null;
  }

  const { rows } = await db.query<JumpRow>(
    `INSERT INTO map_connection_jumps
       (connection_id, map_id, direction, from_eve_system_id, to_eve_system_id,
        from_system_name, to_system_name, character_id, character_name,
        ship_type_id, ship_type_name, ship_group, ship_mass)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${SELECT_COLS}`,
    [
      input.connectionId, input.mapId, input.direction,
      input.fromEveSystemId, input.toEveSystemId, fromName, toName,
      input.characterId, input.characterName,
      input.shipTypeId, typeName, group, massKg,
    ],
  );
  return rows[0];
}

// Wipe a connection's jump log (e.g. a fleet clears it after collapsing a hole).
export async function clearConnectionJumps(connectionId: string, mapId: string): Promise<void> {
  await db.query(
    `DELETE FROM map_connection_jumps WHERE connection_id = $1 AND map_id = $2`,
    [connectionId, mapId],
  );
}
