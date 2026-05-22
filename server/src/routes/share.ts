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
  status:     'not_found' | 'expired' | 'valid';
  mapId?:     string;
  mapName?:   string;
  ownerName?: string;
  expiresAt?: string;
}

export async function lookupShareToken(token: string): Promise<ShareTokenLookup> {
  if (!UUID_RE.test(token)) return { status: 'not_found' };

  const { rows } = await db.query<{
    mapId:     string;
    mapName:   string;
    ownerName: string;
    expiresAt: string | null;
  }>(
    `SELECT m.id              AS "mapId",
            m.name            AS "mapName",
            u.character_name  AS "ownerName",
            m.share_expires_at AS "expiresAt"
       FROM maps m
       JOIN users u ON u.id = m.user_id
      WHERE m.share_token = $1`,
    [token],
  );
  if (!rows.length) return { status: 'not_found' };

  const row = rows[0];
  if (!row.expiresAt || new Date(row.expiresAt).getTime() < Date.now()) {
    return {
      status:    'expired',
      mapId:     row.mapId,
      mapName:   row.mapName,
      ownerName: row.ownerName,
      expiresAt: row.expiresAt ?? undefined,
    };
  }
  return {
    status:    'valid',
    mapId:     row.mapId,
    mapName:   row.mapName,
    ownerName: row.ownerName,
    expiresAt: row.expiresAt,
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

    // Three reads in parallel — same shape the owner endpoint uses, minus
    // notes (stripped below) and structures (not selected at all).
    const mapId = lookup.mapId!;
    const [systems, connections, signatures] = await Promise.all([
      db.query(
        `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass",
                effect, statics, region_name AS "regionName", npc_type AS "npcType",
                position_x AS x, position_y AS y,
                status, is_home AS "isHome", locked,
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
      db.query(
        `SELECT s.id, s.system_id AS "systemId", s.sig_id AS "sigId",
                s.name, s.sig_type AS "type", s.created_at AS "createdAt"
         FROM map_signatures s
         JOIN map_systems sys ON sys.id = s.system_id
         WHERE sys.map_id = $1`,
        [mapId],
      ),
    ]);

    // Group sigs by systemId so the client can hydrate per-system without
    // a second round-trip.
    const sigsBySystem: Record<string, unknown[]> = {};
    for (const sig of signatures.rows as Array<{ systemId: string }>) {
      (sigsBySystem[sig.systemId] ??= []).push(sig);
    }

    res.json({
      mapName:   lookup.mapName,
      ownerName: lookup.ownerName,
      expiresAt: lookup.expiresAt,
      systems: systems.rows.map((s) => ({
        ...s,
        position:  { x: s.x, y: s.y },
        // Notes are intel; explicitly elided from the share payload.
        notes:     '',
        signatures: sigsBySystem[s.id] ?? [],
      })),
      connections: connections.rows,
    });
  } catch (err) {
    log.error('Share lookup failed:', err);
    res.status(500).json({ error: 'internal' });
  }
});
