import { Router } from 'express';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('share');

export const shareRouter = Router();

// UUID v4 format check before we even hit the DB. Cheap rejection of
// obviously-malformed tokens — pgsql's UUID parser would do the same but
// would throw a 500 instead of a clean 404 for our caller.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolves a share token to its underlying map without touching auth.
 * Returns the map row plus a status:
 *   - 'not_found' — no map has this token (revoked or fake)
 *   - 'expired'   — token matched but share_expires_at is in the past
 *   - 'valid'     — usable; caller can fetch payload
 *
 * Owner name (character_name) is included on both 'expired' and 'valid'
 * so the expired-page can identify who issued the link and the shared
 * map can credit the source.
 */
export interface ShareTokenLookup {
  status:             'not_found' | 'expired' | 'valid';
  mapId?:             string;
  mapName?:           string;
  ownerName?:         string;
  expiresAt?:         string;
  includeSigs?:       boolean;
  includeBridges?:    boolean;
  includeNotes?:      boolean;
  includeStructures?: boolean;
}

export async function lookupShareToken(token: string): Promise<ShareTokenLookup> {
  if (!UUID_RE.test(token)) return { status: 'not_found' };

  const { rows } = await db.query<{
    mapId:             string;
    mapName:           string;
    ownerName:         string;
    expiresAt:         string | null;
    includeSigs:       boolean;
    includeBridges:    boolean;
    includeNotes:      boolean;
    includeStructures: boolean;
  }>(
    `SELECT m.id                       AS "mapId",
            m.name                     AS "mapName",
            u.character_name           AS "ownerName",
            m.share_expires_at         AS "expiresAt",
            m.share_include_sigs       AS "includeSigs",
            m.share_include_bridges    AS "includeBridges",
            m.share_include_notes      AS "includeNotes",
            m.share_include_structures AS "includeStructures"
       FROM maps m
       JOIN users u ON u.id = m.user_id
      WHERE m.share_token = $1`,
    [token],
  );
  if (!rows.length) return { status: 'not_found' };

  const row = rows[0];
  if (!row.expiresAt || new Date(row.expiresAt).getTime() < Date.now()) {
    return {
      status:            'expired',
      mapId:             row.mapId,
      mapName:           row.mapName,
      ownerName:         row.ownerName,
      expiresAt:         row.expiresAt ?? undefined,
      includeSigs:       row.includeSigs,
      includeBridges:    row.includeBridges,
      includeNotes:      row.includeNotes,
      includeStructures: row.includeStructures,
    };
  }
  return {
    status:            'valid',
    mapId:             row.mapId,
    mapName:           row.mapName,
    ownerName:         row.ownerName,
    expiresAt:         row.expiresAt,
    includeSigs:       row.includeSigs,
    includeBridges:    row.includeBridges,
    includeNotes:      row.includeNotes,
    includeStructures: row.includeStructures,
  };
}

// GET /api/share/:token
// Public, no auth. Returns the read-only map snapshot:
//   - map metadata (name, owner name, share expiry)
//   - systems (no notes — those are intel)
//   - connections (full)
//   - signatures per system (intel but explicitly chosen to share)
// Structures are NOT returned. Notes are stripped from systems.
shareRouter.get('/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const lookup = await lookupShareToken(token);

    if (lookup.status === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (lookup.status === 'expired') {
      res.status(410).json({
        error:     'expired',
        ownerName: lookup.ownerName,
        mapName:   lookup.mapName,
        expiredAt: lookup.expiresAt,
      });
      return;
    }

    // Reads in parallel — shape mirrors the owner endpoint, with each
    // optional category gated on a link-level flag. SQL guards on the
    // server so excluded rows never leave the DB (defence in depth in
    // case a logging proxy ever sees the response body).
    const mapId             = lookup.mapId!;
    const includeSigs       = lookup.includeSigs       === true;
    const includeBridges    = lookup.includeBridges    === true;
    const includeNotes      = lookup.includeNotes      === true;
    const includeStructures = lookup.includeStructures === true;
    const connectionWhere = includeBridges
      ? 'WHERE map_id = $1'
      : `WHERE map_id = $1 AND connection_type <> 'jumpgate'`;

    const [systems, connections, signatures, structures] = await Promise.all([
      db.query(
        `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass",
                effect, statics, region_name AS "regionName", npc_type AS "npcType",
                position_x AS x, position_y AS y,
                status, is_home AS "isHome", locked,
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
                eol_at AS "eolAt",
                created_at AS "createdAt"
         FROM map_connections ${connectionWhere}`,
        [mapId],
      ),
      includeSigs
        ? db.query(
            // Aliases match the owner-side /api/maps/:mapId/.../signatures
            // shape exactly so the SignaturePane consumes them with the same
            // field names — otherwise sigType arrives undefined and every
            // row renders as "unknown".
            `SELECT s.id, s.system_id AS "systemId", s.sig_id AS "sigId",
                    s.sig_type AS "sigType", s.name, s.notes,
                    s.wh_type AS "whType", s.wh_leads_to AS "whLeadsTo",
                    s.created_at AS "createdAt", s.updated_at AS "updatedAt"
             FROM map_signatures s
             JOIN map_systems sys ON sys.id = s.system_id
             WHERE sys.map_id = $1`,
            [mapId],
          )
        : Promise.resolve({ rows: [] as Array<{ systemId: string }> }),
      includeStructures
        ? db.query(
            // Aliases mirror the owner-side GET so StructuresPane reads
            // identically. system_id is exposed so we can group by-system
            // before the response leaves the server.
            `SELECT st.id, st.system_id AS "systemId", st.name,
                    st.structure_type AS "structureType",
                    st.owner_corp AS "ownerCorp", st.eve_id AS "eveId",
                    st.notes, st.created_at AS "createdAt",
                    st.owner_corp_id AS "ownerCorpId"
             FROM map_structures st
             JOIN map_systems sys ON sys.id = st.system_id
             WHERE sys.map_id = $1`,
            [mapId],
          )
        : Promise.resolve({ rows: [] as Array<{ systemId: string }> }),
    ]);

    // Group sigs and structures by systemId so the client can hydrate
    // per-system without a second round-trip.
    const sigsBySystem: Record<string, unknown[]> = {};
    for (const sig of signatures.rows as Array<{ systemId: string }>) {
      (sigsBySystem[sig.systemId] ??= []).push(sig);
    }
    const structuresBySystem: Record<string, unknown[]> = {};
    for (const st of structures.rows as Array<{ systemId: string }>) {
      (structuresBySystem[st.systemId] ??= []).push(st);
    }

    res.json({
      mapName:           lookup.mapName,
      ownerName:         lookup.ownerName,
      expiresAt:         lookup.expiresAt,
      includeSigs,
      includeBridges,
      includeNotes,
      includeStructures,
      systems: systems.rows.map((s) => ({
        ...s,
        position:   { x: s.x, y: s.y },
        // Notes only flow when explicitly opted in.
        notes:      includeNotes ? s.notes : '',
        signatures: sigsBySystem[s.id] ?? [],
        structures: structuresBySystem[s.id] ?? [],
      })),
      connections: connections.rows,
    });
  } catch (err) {
    log.error('Share lookup failed:', err);
    res.status(500).json({ error: 'internal' });
  }
});
