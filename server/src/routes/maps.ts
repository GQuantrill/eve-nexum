import { Router } from 'express';
import type { Request, Response } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { config } from '../config.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('maps');

// Best-effort ESI lookup of a player structure's owner corp ID. Requires
// the user's `esi-universe.read_structures.v1` scope and access to the
// structure itself (member of the owning corp or its alliance, or it
// being a public structure). 403/404 just means "we can't resolve it",
// not an error.
async function resolveStructureOwnerCorp(
  userId: number,
  eveStructureId: number,
): Promise<number | null> {
  try {
    const { rows } = await db.query<{ access_token: string }>(
      `SELECT access_token FROM users WHERE id = $1`, [userId],
    );
    if (!rows.length) return null;
    const token = decryptToken(rows[0].access_token);
    const r = await fetch(`https://esi.evetech.net/v2/universe/structures/${eveStructureId}/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      if (r.status !== 403 && r.status !== 404) {
        log.warn(`ESI structure ${eveStructureId} returned ${r.status}`);
      }
      return null;
    }
    const data = await r.json() as { owner_id?: number };
    return data.owner_id ?? null;
  } catch (err) {
    log.error('resolveStructureOwnerCorp failed:', err);
    return null;
  }
}

export const mapsRouter = Router();
mapsRouter.use(requireAuth);

// ── Access control helpers ────────────────────────────────────────────────────

interface MapMeta { userId: number; corpId: number | null; locked: boolean; }

async function getMapAccess(mapId: string, req: Request): Promise<MapMeta | null> {
  const userId = req.session.userId!;
  const { rows } = await db.query<MapMeta>(
    `SELECT user_id AS "userId", corp_id AS "corpId", locked FROM maps WHERE id = $1`,
    [mapId],
  );
  if (!rows.length) return null;
  const m = rows[0];
  const isOwner   = m.userId === userId;
  // A corp map is visible if the user is in the same corp as the map's
  // creator (or CORP_MAP_SHARED is true, in which case any member of any
  // listed corp can see it).
  const isCorpMap = config.corpMode
    && m.corpId !== null
    && config.corpIds.includes(m.corpId)
    && (config.corpMapShared || m.corpId === (req.session.userCorpId ?? null));
  return (isOwner || isCorpMap) ? m : null;
}

// Two tiers of write permission:
//
//   - requireMapContentWrite enforces *only* the role check. Used for routes
//     that mutate per-system content (signatures, structures, notes). An
//     admin-applied map lock freezes topology but leaves these open so the
//     map can still be used operationally while the layout is frozen.
//
//   - requireMapWrite is the strict version — role check plus lock check.
//     Used for everything that changes the map's *shape*: adding/removing
//     systems, moving systems, connections, map rename.
//
// Both helpers send the appropriate 403/404 and return null on failure.
async function requireMapContentWrite(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return null; }

  const role = req.session.role ?? 'readonly';
  const isCorpMap = config.corpMode
    && access.corpId !== null
    && config.corpIds.includes(access.corpId);

  // Corp maps: any role except readonly can edit (edit / full / admin).
  // Personal maps: owner is allowed regardless of role.
  if (isCorpMap && role === 'readonly') {
    res.status(403).json({ error: 'Write access required' }); return null;
  }
  return access;
}

async function requireMapWrite(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return null;

  if (access.locked && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Map is locked' }); return null;
  }
  return access;
}

// Confirms a system UUID actually belongs to the supplied map; prevents
// cross-map IDOR on signature/structure routes that take a systemId param.
async function verifySystemInMap(res: Response, systemId: string, mapId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM map_systems WHERE id = $1 AND map_id = $2`,
    [systemId, mapId],
  );
  if (!rowCount) { res.status(404).json({ error: 'System not found' }); return false; }
  return true;
}

// ── Maps ──────────────────────────────────────────────────────────────────────

const MAX_MAP_NAME_LEN  = 200;
const MAX_IMPORT_SYSTEMS     = 500;
const MAX_IMPORT_CONNECTIONS = 2000;

// GET /api/maps
mapsRouter.get('/', async (req, res) => {
  let query: string;
  let params: unknown[];

  if (config.corpMode && config.corpIds.length > 0) {
    // Personal maps owned by this user + visible corp maps. When
    // CORP_MAP_SHARED is true, every member of any listed corp sees every
    // corp map. When false, only the user's own corp's maps are visible.
    const visibleCorpIds = config.corpMapShared
      ? config.corpIds
      : (req.session.userCorpId ? [req.session.userCorpId] : []);
    query = `SELECT id, name, corp_id IS NOT NULL AS "isCorpMap", locked,
                    last_active_at AS "lastActiveAt", created_at AS "createdAt", updated_at AS "updatedAt"
             FROM maps
             WHERE (user_id = $1 AND corp_id IS NULL) OR corp_id = ANY($2::int[])
             ORDER BY corp_id NULLS LAST, name`;
    params = [req.session.userId, visibleCorpIds];
  } else {
    query = `SELECT id, name, FALSE AS "isCorpMap", locked,
                    last_active_at AS "lastActiveAt", created_at AS "createdAt", updated_at AS "updatedAt"
             FROM maps WHERE user_id = $1 ORDER BY created_at`;
    params = [req.session.userId];
  }

  const { rows } = await db.query(query, params);
  // Count corp maps for the user's own corp (the per-corp limit applies to
  // each corp independently — Corp A's slots are separate from Corp B's).
  const corpMapCount = config.corpMode && req.session.userCorpId
    ? (await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [req.session.userCorpId])).rowCount ?? 0
    : 0;

  res.json({ maps: rows, maxMaps: config.maxUserMaps, maxCorpMaps: config.maxCorpMaps, corpMapCount });
});

// POST /api/maps
mapsRouter.post('/', async (req, res) => {
  const isCorpMap = config.corpMode && req.body.isCorpMap === true;
  const role      = req.session.role ?? 'readonly';

  // Personal map creation is open to every role — they're scoped to the
  // individual user, so role gating only matters for shared (corp) maps.
  // Corp map creation still requires 'full' or 'admin'.
  if (isCorpMap) {
    if (role !== 'full' && role !== 'admin') {
      res.status(403).json({ error: 'Corp map creation requires full-edit or admin role' });
      return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot create corp map: user has no corp affiliation' });
      return;
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE corp_id = $1`,
      [req.session.userCorpId],
    );
    if ((rowCount ?? 0) >= config.maxCorpMaps) {
      res.status(403).json({ error: 'Maximum corp maps reached' });
      return;
    }
  } else {
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE user_id = $1 AND corp_id IS NULL`,
      [req.session.userId],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const name   = String(req.body.name ?? 'New Map').slice(0, MAX_MAP_NAME_LEN);
  const corpId = isCorpMap ? (req.session.userCorpId ?? null) : null;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name, corp_id) VALUES ($1, $2, $3) RETURNING id`,
    [req.session.userId, name, corpId],
  );
  res.status(201).json({ id: rows[0].id });
});

// POST /api/maps/import
mapsRouter.post('/import', async (req, res) => {
  const isCorpImport = config.corpMode && (req.body as Record<string, unknown>).isCorpMap === true;
  const role         = req.session.role ?? 'readonly';

  // Quota check against the matching tier — importing a corp map counts
  // against MAX_CORP_MAPS (for the user's corp), importing a personal map
  // counts against MAX_USER_MAPS. Previously this always checked the
  // personal quota, so corp imports skipped MAX_CORP_MAPS entirely.
  // Personal imports are open to every role; corp imports need full/admin.
  if (isCorpImport) {
    if (role !== 'full' && role !== 'admin') {
      res.status(403).json({ error: 'Corp map import requires full-edit or admin role' });
      return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot import corp map: user has no corp affiliation' });
      return;
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE corp_id = $1`,
      [req.session.userCorpId],
    );
    if ((rowCount ?? 0) >= config.maxCorpMaps) {
      res.status(403).json({ error: 'Maximum corp maps reached' });
      return;
    }
  } else {
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE user_id = $1 AND corp_id IS NULL`,
      [req.session.userId],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const { name, systems = [], connections = [] } = req.body as {
    name?: string;
    systems?: Array<Record<string, unknown>>;
    connections?: Array<Record<string, unknown>>;
  };

  if (!Array.isArray(systems) || !Array.isArray(connections)) {
    res.status(400).json({ error: 'systems and connections must be arrays' });
    return;
  }
  if (systems.length > MAX_IMPORT_SYSTEMS) {
    res.status(413).json({ error: `Too many systems (max ${MAX_IMPORT_SYSTEMS})` });
    return;
  }
  if (connections.length > MAX_IMPORT_CONNECTIONS) {
    res.status(413).json({ error: `Too many connections (max ${MAX_IMPORT_CONNECTIONS})` });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const importName = String(name ?? 'Imported Map').slice(0, MAX_MAP_NAME_LEN);
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, corp_id) VALUES ($1, $2, $3) RETURNING id`,
      [req.session.userId, importName, isCorpImport ? (req.session.userCorpId ?? null) : null],
    );
    const mapId = mapRes.rows[0].id;

    // Remap old system UUIDs → fresh ones to avoid any collisions on re-import.
    // Build the rows up first, then bulk-insert in one round-trip each.
    const idMap = new Map<string, string>();
    if (systems.length > 0) {
      const sysCols = 15;
      const sysPlaceholders: string[] = [];
      const sysValues: unknown[] = [];
      for (const sys of systems) {
        const newId = crypto.randomUUID();
        idMap.set(String(sys.id), newId);
        const pos = (sys.position as { x: number; y: number }) ?? { x: 0, y: 0 };
        const base = sysValues.length;
        sysPlaceholders.push(`(${Array.from({ length: sysCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
        sysValues.push(
          newId, mapId, sys.eveSystemId ?? null, sys.name, sys.systemClass,
          sys.effect ?? 'none', sys.statics ?? [], sys.regionName ?? null, sys.npcType ?? null,
          pos.x, pos.y, sys.status ?? 'unknown', sys.isHome ?? false, sys.locked ?? false, sys.notes ?? '',
        );
      }
      await client.query(
        `INSERT INTO map_systems
           (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
            position_x, position_y, status, is_home, locked, notes)
         VALUES ${sysPlaceholders.join(',')}`,
        sysValues,
      );
    }

    const validConns = connections
      .map((conn) => {
        const srcId = idMap.get(String(conn.sourceId));
        const tgtId = idMap.get(String(conn.targetId));
        if (!srcId || !tgtId) return null;
        return { conn, srcId, tgtId };
      })
      .filter((c): c is { conn: Record<string, unknown>; srcId: string; tgtId: string } => c !== null);

    if (validConns.length > 0) {
      const connCols = 10;
      const connPlaceholders: string[] = [];
      const connValues: unknown[] = [];
      for (const { conn, srcId, tgtId } of validConns) {
        const base = connValues.length;
        connPlaceholders.push(`(${Array.from({ length: connCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
        connValues.push(
          crypto.randomUUID(), mapId, srcId, tgtId,
          conn.sourceHandle ?? null, conn.targetHandle ?? null,
          conn.connectionType ?? 'standard', conn.massStatus ?? null,
          conn.timeStatus ?? null, conn.size ?? 'large',
        );
      }
      await client.query(
        `INSERT INTO map_connections
           (id, map_id, source_id, target_id, source_handle, target_handle,
            connection_type, mass_status, time_status, size)
         VALUES ${connPlaceholders.join(',')}`,
        connValues,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: mapId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/maps/:mapId  — full map (systems + connections)
mapsRouter.get('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  // Three independent reads — parallelise so total latency is max(t) instead
  // of sum(t).
  const [mapRows, systems, connections] = await Promise.all([
    db.query(
      `SELECT id, name, corp_id IS NOT NULL AS "isCorpMap", locked,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM maps WHERE id = $1`,
      [mapId],
    ),
    db.query(
      `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass",
              effect, statics, region_name AS "regionName", npc_type AS "npcType",
              position_x AS x, position_y AS y,
              status, is_home AS "isHome", locked, notes,
              last_activity_at AS "lastActivityAt"
       FROM map_systems WHERE map_id = $1`,
      [mapId],
    ),
    db.query(
      `SELECT id, source_id AS "sourceId", target_id AS "targetId",
              source_handle AS "sourceHandle", target_handle AS "targetHandle",
              connection_type AS "connectionType", mass_status AS "massStatus",
              time_status AS "timeStatus", size, wh_type AS "type",
              COALESCE(mass_used, 0)::float8 AS "massUsed",
              eol_at AS "eolAt",
              created_at AS "createdAt"
       FROM map_connections WHERE map_id = $1`,
      [mapId],
    ),
  ]);

  if (!mapRows.rows.length) { res.status(404).json({ error: 'Map not found' }); return; }

  res.json({
    ...mapRows.rows[0],
    systems: systems.rows.map((s) => ({ ...s, position: { x: s.x, y: s.y } })),
    connections: connections.rows,
  });
});

// PATCH /api/maps/:mapId  — rename or lock (lock: admin only)
mapsRouter.patch('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const { name, locked } = req.body as { name?: string; locked?: boolean };

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];

  if (name !== undefined) {
    const trimmed = String(name).slice(0, MAX_MAP_NAME_LEN);
    if (!trimmed) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    sets.push(`name = $${vals.length + 1}`); vals.push(trimmed);
  }
  if (locked !== undefined) {
    if (req.session.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
    sets.push(`locked = $${vals.length + 1}`); vals.push(locked);
  }

  if (sets.length === 1) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(`UPDATE maps SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, mapId]);
  res.json({ ok: true });
});

// DELETE /api/maps/:mapId — owner can delete personal maps; admin can delete any
mapsRouter.delete('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  const isOwner  = access.userId === req.session.userId;
  const isCorpMap = access.corpId !== null;

  if (isCorpMap && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can delete corp maps' }); return;
  }
  if (!isOwner && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Not authorised' }); return;
  }

  await db.query(`DELETE FROM maps WHERE id = $1`, [mapId]);
  res.json({ ok: true });
});

// ── Systems ───────────────────────────────────────────────────────────────────

mapsRouter.post('/:mapId/systems', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const { id, eveSystemId, name, systemClass, effect, statics, regionName, npcType, position, status, isHome, locked, notes } = req.body;

  await db.query(
    `INSERT INTO map_systems
       (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
        position_x, position_y, status, is_home, locked, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO NOTHING`,
    [id, mapId, eveSystemId ?? null, name, systemClass, effect ?? 'none',
     statics ?? [], regionName ?? null, npcType ?? null,
     position?.x ?? 0, position?.y ?? 0,
     status ?? 'unknown', isHome ?? false, locked ?? false, notes ?? ''],
  );
  db.query(
    `INSERT INTO user_events (user_id, event_type, map_id) VALUES ($1, 'system_add', $2)`,
    [req.session.userId, mapId],
  ).catch(console.error);
  await touchMap(mapId);
  res.status(201).json({ ok: true });
});

mapsRouter.patch('/:mapId/systems/:systemId', async (req, res) => {
  const { mapId, systemId } = req.params;
  const updates = req.body as Record<string, unknown>;

  const allowed = ['name','system_class','effect','statics','region_name','npc_type',
                   'position_x','position_y','status','is_home','locked','notes'];

  // map camelCase → snake_case for the DB columns we accept
  const colMap: Record<string, string> = {
    name: 'name', systemClass: 'system_class', effect: 'effect', statics: 'statics',
    regionName: 'region_name', npcType: 'npc_type',
    status: 'status', isHome: 'is_home', locked: 'locked', notes: 'notes',
  };

  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(updates[key]);
    }
  }

  // handle position separately
  if (updates.position && typeof updates.position === 'object') {
    const pos = updates.position as { x?: number; y?: number };
    if (pos.x !== undefined) { sets.push(`position_x = $${vals.length + 1}`); vals.push(pos.x); }
    if (pos.y !== undefined) { sets.push(`position_y = $${vals.length + 1}`); vals.push(pos.y); }
  }

  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  // Notes-only updates are content, not topology — they pass through even
  // when an admin has locked the map. Anything else (move, rename, status…)
  // requires the strict lock-aware check.
  const isNotesOnly = Object.keys(updates).length === 1 && 'notes' in updates;
  const access = isNotesOnly
    ? await requireMapContentWrite(res, mapId, req)
    : await requireMapWrite(res, mapId, req);
  if (!access) return;

  // Append last_activity_at = NOW() to mark this system as active.
  await db.query(
    `UPDATE map_systems SET ${sets.join(', ')}, last_activity_at = NOW() WHERE id = $${vals.length + 1} AND map_id = $${vals.length + 2}`,
    [...vals, systemId, mapId],
  );
  await touchMap(mapId);
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  const { rowCount } = await db.query(`DELETE FROM map_systems WHERE id = $1 AND map_id = $2`, [systemId, mapId]);
  if ((rowCount ?? 0) > 0) {
    db.query(
      `INSERT INTO user_events (user_id, event_type, map_id) VALUES ($1, 'system_delete', $2)`,
      [req.session.userId, mapId],
    ).catch(console.error);
  }
  await touchMap(mapId);
  res.json({ ok: true });
});

// ── Connections ───────────────────────────────────────────────────────────────

mapsRouter.post('/:mapId/connections', async (req, res) => {
  const { mapId } = req.params;
  const { id, sourceId, targetId, sourceHandle, targetHandle, connectionType, massStatus, timeStatus, size } = req.body;

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  await db.query(
    `INSERT INTO map_connections
       (id, map_id, source_id, target_id, source_handle, target_handle,
        connection_type, mass_status, time_status, size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [id, mapId, sourceId, targetId, sourceHandle ?? null, targetHandle ?? null,
     connectionType ?? 'standard', massStatus ?? null, timeStatus ?? null, size ?? 'large'],
  );
  await touchMap(mapId);
  res.status(201).json({ ok: true });
});

mapsRouter.patch('/:mapId/connections/:connectionId', async (req, res) => {
  const { mapId, connectionId } = req.params;

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const colMap: Record<string, string> = {
    connectionType: 'connection_type', massStatus: 'mass_status',
    timeStatus: 'time_status', size: 'size',
    sourceHandle: 'source_handle', targetHandle: 'target_handle',
    type: 'wh_type', massUsed: 'mass_used',
    eolAt: 'eol_at',
  };

  const updates = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(updates[key]);
    }
  }

  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(
    `UPDATE map_connections SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND map_id = $${vals.length + 2}`,
    [...vals, connectionId, mapId],
  );
  await touchMap(mapId);
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/connections/:connectionId', async (req, res) => {
  const { mapId, connectionId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  await db.query(`DELETE FROM map_connections WHERE id = $1 AND map_id = $2`, [connectionId, mapId]);
  await touchMap(mapId);
  res.json({ ok: true });
});

// ── Signatures ────────────────────────────────────────────────────────────────

mapsRouter.get('/:mapId/systems/:systemId/signatures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { rows } = await db.query(
    `SELECT id, sig_id AS "sigId", sig_type AS "sigType", name, notes, wh_type AS "whType", wh_leads_to AS "whLeadsTo", created_at AS "createdAt"
     FROM map_signatures WHERE system_id = $1 ORDER BY created_at`,
    [systemId],
  );
  res.json(rows);
});

mapsRouter.post('/:mapId/systems/:systemId/signatures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { sigId = '', sigType = 'unknown', name = '', notes = '', whType = '', whLeadsTo = '' } = req.body as Record<string, string>;
  const { rows } = await db.query(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, sig_id AS "sigId", sig_type AS "sigType", name, notes, wh_type AS "whType", wh_leads_to AS "whLeadsTo", created_at AS "createdAt"`,
    [systemId, sigId, sigType, name, notes, whType, whLeadsTo, req.session.userId],
  );
  db.query(
    `INSERT INTO user_events (user_id, event_type, sig_type) VALUES ($1, 'signature', $2)`,
    [req.session.userId, sigType],
  ).catch(console.error);
  db.query(`UPDATE map_systems SET last_activity_at = NOW() WHERE id = $1`, [systemId]).catch(console.error);
  res.status(201).json(rows[0]);
});

mapsRouter.patch('/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  const { mapId, systemId, sigId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;

  const colMap: Record<string, string> = { sigId: 'sig_id', sigType: 'sig_type', name: 'name', notes: 'notes', whType: 'wh_type', whLeadsTo: 'wh_leads_to' };
  const updates = req.body as Record<string, unknown>;
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }

  await db.query(
    `UPDATE map_signatures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2}`,
    [...vals, sigId, systemId],
  );
  db.query(`UPDATE map_systems SET last_activity_at = NOW() WHERE id = $1`, [systemId]).catch(console.error);
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  const { mapId, systemId, sigId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  await db.query(`DELETE FROM map_signatures WHERE id = $1 AND system_id = $2`, [sigId, systemId]);
  db.query(`UPDATE map_systems SET last_activity_at = NOW() WHERE id = $1`, [systemId]).catch(console.error);
  res.json({ ok: true });
});

// ── Structures (manual player structures) ─────────────────────────────────────

mapsRouter.get('/:mapId/systems/:systemId/structures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { rows } = await db.query(
    `SELECT id, name, structure_type AS "structureType", owner_corp AS "ownerCorp", eve_id AS "eveId", notes, created_at AS "createdAt", owner_corp_id AS "ownerCorpId"
     FROM map_structures WHERE system_id = $1 ORDER BY created_at`,
    [systemId],
  );
  res.json(rows);
});

mapsRouter.post('/:mapId/systems/:systemId/structures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { name = '', structureType = 'unknown', ownerCorp = '', notes = '', eveId = null } = req.body as Record<string, string>;
  const eveIdNum = eveId ? Number(eveId) : null;

  // Block briefly on ESI to resolve the owner corp when an eve_id is
  // supplied. If the call fails (private structure / missing scope /
  // bad ID) we just leave owner_corp_id NULL — the row still goes in.
  const ownerCorpId = eveIdNum && req.session.userId
    ? await resolveStructureOwnerCorp(req.session.userId, eveIdNum)
    : null;

  const { rows } = await db.query(
    `INSERT INTO map_structures (system_id, name, structure_type, owner_corp, eve_id, notes, created_by_user_id, owner_corp_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, structure_type AS "structureType", owner_corp AS "ownerCorp", eve_id AS "eveId", notes, created_at AS "createdAt", owner_corp_id AS "ownerCorpId"`,
    [systemId, name, structureType, ownerCorp, eveIdNum, notes, req.session.userId, ownerCorpId],
  );
  res.status(201).json(rows[0]);
});

mapsRouter.patch('/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  const { mapId, systemId, structureId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;

  const colMap: Record<string, string> = { name: 'name', structureType: 'structure_type', ownerCorp: 'owner_corp', eveId: 'eve_id', notes: 'notes' };
  const updates = req.body as Record<string, unknown>;
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }

  await db.query(
    `UPDATE map_structures SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND system_id = $${vals.length + 2}`,
    [...vals, structureId, systemId],
  );
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  const { mapId, systemId, structureId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  await db.query(`DELETE FROM map_structures WHERE id = $1 AND system_id = $2`, [structureId, systemId]);
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function touchMap(mapId: string) {
  await db.query(`UPDATE maps SET updated_at = NOW(), last_active_at = NOW() WHERE id = $1`, [mapId]);
}
