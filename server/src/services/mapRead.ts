import { db } from '../db.js';
import { config } from '../config.js';

// Shared map READ queries — the single source of truth behind both the
// cookie-authed map routes and the external /api/v1 key-authed routes. Pure
// data loaders: no req/res, no access checks (callers gate with getMapAccess
// first). Keeping these here means the two surfaces can never drift in shape.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface VisibleMapsParams {
  userId:     number;
  ownerId:    number | null;
  userCorpId: number | null;
  callerChar: number | null;
}

// The list of maps visible to an account: personal (owner) maps, corp maps in
// the configured corp set, and personal maps explicitly shared with the
// character or their corp. Identical query to GET /api/maps.
export async function listVisibleMaps(p: VisibleMapsParams) {
  const visibleCorpIds = config.corpMode && config.corpIds.length > 0
    ? (config.corpMapShared ? config.corpIds : (p.userCorpId ? [p.userCorpId] : []))
    : [];
  // -1 is an impossible owner id so the ownership clause matches nothing rather
  // than everything when ownerId is unknown.
  const ownerId = p.ownerId ?? -1;
  const { rows } = await db.query(
    `SELECT DISTINCT
            m.id,
            m.name,
            m.corp_id IS NOT NULL AS "isCorpMap",
            (m.user_id <> $1 AND m.owner_id IS DISTINCT FROM $5::int
              AND (m.corp_id IS NULL OR NOT m.corp_id = ANY($2::int[]))
            ) AS "sharedWithMe",
            m.locked,
            ou.character_name             AS "ownerName",
            m.allow_as_merge_source       AS "allowAsMergeSource",
            m.allow_as_merge_destination  AS "allowAsMergeDestination",
            m.lazy_remove_wormholes       AS "lazyRemoveWormholes",
            m.last_active_at AS "lastActiveAt",
            m.created_at     AS "createdAt",
            m.updated_at     AS "updatedAt"
       FROM maps m
       JOIN users ou ON ou.id = m.user_id
       LEFT JOIN map_shares s ON s.map_id = m.id
            AND ( s.target_character_id = $3
               OR ($4::int IS NOT NULL AND s.target_corp_id = $4) )
      WHERE ((m.owner_id = $5::int OR m.user_id = $1) AND m.corp_id IS NULL)
         OR m.corp_id = ANY($2::int[])
         OR (s.id IS NOT NULL AND m.corp_id IS NULL)
      ORDER BY "sharedWithMe", "isCorpMap", m.name`,
    [p.userId, visibleCorpIds, p.callerChar, p.userCorpId, ownerId],
  );
  return rows;
}

// Full map: meta + systems (with {x,y} folded into position) + connections.
// Returns null if the map row vanished between the access check and this load.
export async function loadFullMap(mapId: string) {
  const [mapRows, systems, connections, routes] = await Promise.all([
    db.query(
      `SELECT id, name, corp_id IS NOT NULL AS "isCorpMap", locked,
              allow_as_merge_source       AS "allowAsMergeSource",
              allow_as_merge_destination  AS "allowAsMergeDestination",
              lazy_remove_wormholes       AS "lazyRemoveWormholes",
              share_token              AS "shareToken",
              share_expires_at         AS "shareExpiresAt",
              share_include_sigs       AS "shareIncludeSigs",
              share_include_bridges    AS "shareIncludeBridges",
              share_include_notes      AS "shareIncludeNotes",
              share_include_structures AS "shareIncludeStructures",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM maps WHERE id = $1`,
      [mapId],
    ),
    db.query(
      `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass",
              effect, statics, region_name AS "regionName", npc_type AS "npcType",
              position_x AS x, position_y AS y,
              status, intel, is_home AS "isHome", locked, notes,
              labels, custom_labels AS "customLabels",
              (SELECT ss.security::float8 FROM solar_systems ss WHERE ss.id = map_systems.eve_system_id) AS "security",
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
              eol_at AS "eolAt", broken,
              source_signature_id AS "sourceSignatureId",
              target_signature_id AS "targetSignatureId",
              created_at AS "createdAt"
       FROM map_connections WHERE map_id = $1`,
      [mapId],
    ),
    db.query(
      `SELECT id, name, system_ids AS "systemIds", connection_ids AS "connectionIds",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM map_routes WHERE map_id = $1 ORDER BY sort_order, created_at`,
      [mapId],
    ),
  ]);

  if (!mapRows.rows.length) return null;
  return {
    ...mapRows.rows[0],
    systems: systems.rows.map((s) => ({ ...s, position: { x: s.x, y: s.y } })),
    connections: connections.rows,
    routes: routes.rows,
  };
}

// Confirms a system UUID belongs to the map — guards cross-map IDOR and the
// malformed-uuid 22P02 crash. Pure boolean (no res side effects).
export async function isSystemInMap(systemId: string, mapId: string): Promise<boolean> {
  if (!UUID_RE.test(systemId)) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM map_systems WHERE id = $1 AND map_id = $2`,
    [systemId, mapId],
  );
  return !!rowCount;
}

export async function loadSystemSignatures(systemId: string) {
  const { rows } = await db.query(
    `SELECT id, sig_id AS "sigId", sig_type AS "sigType", name, notes,
            wh_type AS "whType", wh_leads_to AS "whLeadsTo", created_at AS "createdAt"
       FROM map_signatures WHERE system_id = $1 ORDER BY created_at`,
    [systemId],
  );
  return rows;
}

export async function loadSystemAnomalies(systemId: string) {
  const { rows } = await db.query(
    `SELECT id, anom_id AS "anomId", anom_type AS "anomType", name, notes,
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM map_anomalies WHERE system_id = $1 ORDER BY created_at`,
    [systemId],
  );
  return rows;
}

export async function loadSystemStructures(systemId: string) {
  const { rows } = await db.query(
    `SELECT id, name, structure_type AS "structureType", owner_corp AS "ownerCorp",
            eve_id AS "eveId", notes, created_at AS "createdAt", owner_corp_id AS "ownerCorpId"
       FROM map_structures WHERE system_id = $1 ORDER BY created_at`,
    [systemId],
  );
  return rows;
}
