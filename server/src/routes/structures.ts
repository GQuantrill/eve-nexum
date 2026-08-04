import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { syncCorpStructures } from '../services/structureSync.js';
import { visibleMapIds } from './maps.js';

// Structures usable as jump-planner endpoints. GET merges two sources: the
// caller's corp structures synced from ESI (role-gated) AND structures manually
// tagged on maps the caller can see (no role needed — the fallback for corps too
// big to find a Station Manager). POST /refresh forces the ESI sync.
const log = createLogger('structures');
export const structuresRouter = Router();
structuresRouter.use(requireAuth);

interface StructureRow {
  eveId: string | null; name: string; typeName: string | null;
  solarSystemId: number | null; systemName: string | null; systemClass: string | null;
}

// GET /api/structures — corp (ESI) + map-tagged structures, deduped, with a
// `source` flag and the containing system's name/class (so the client can flag
// non-LS/NS ones). Deduped by EVE structure id when known, else system+name.
structuresRouter.get('/', async (req, res) => {
  const userId = req.session.userId!;
  try {
    const { rows: ur } = await db.query<{ corp_id: number | null }>(
      `SELECT corp_id FROM users WHERE id = $1`, [userId],
    );
    const corpId = ur[0]?.corp_id ?? null;

    const corpRows = corpId
      ? (await db.query<StructureRow>(
          `SELECT s.structure_id::text AS "eveId", s.name, s.type_name AS "typeName",
                  s.solar_system_id AS "solarSystemId", ss.name AS "systemName", ss.class AS "systemClass"
             FROM structures s
             LEFT JOIN solar_systems ss ON ss.id = s.solar_system_id
            WHERE s.corporation_id = $1`, [corpId])).rows
      : [];

    const mapIds = await visibleMapIds(req);
    const mapRows = mapIds.length
      ? (await db.query<StructureRow>(
          `SELECT ms.eve_id::text AS "eveId", ms.name, NULLIF(ms.structure_type, 'unknown') AS "typeName",
                  msys.eve_system_id AS "solarSystemId", ss.name AS "systemName", ss.class AS "systemClass"
             FROM map_structures ms
             JOIN map_systems msys ON msys.id = ms.system_id
             LEFT JOIN solar_systems ss ON ss.id = msys.eve_system_id
            WHERE msys.map_id = ANY($1::uuid[]) AND ms.name <> '' AND msys.eve_system_id IS NOT NULL`,
          [mapIds])).rows
      : [];

    // Merge, corp first so the authoritative row wins a dedup tie.
    const byKey = new Map<string, { key: string; name: string; typeName: string; solarSystemId: number | null; systemName: string | null; systemClass: string | null; source: 'corp' | 'map' }>();
    const add = (r: StructureRow, source: 'corp' | 'map') => {
      const key = r.eveId ? `e${r.eveId}` : `n${r.solarSystemId}|${r.name.toLowerCase()}`;
      if (!byKey.has(key)) {
        byKey.set(key, { key, name: r.name, typeName: r.typeName ?? '', solarSystemId: r.solarSystemId, systemName: r.systemName, systemClass: r.systemClass, source });
      }
    };
    corpRows.forEach((r) => add(r, 'corp'));
    mapRows.forEach((r) => add(r, 'map'));
    const list = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    return res.json(list);
  } catch (err) { log.error('list failed', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// POST /api/structures/refresh — sync from ESI. Non-'ok' non-'error' outcomes
// (no_corp / no_role / needs_reauth) are 200s carrying a status the UI explains.
structuresRouter.post('/refresh', async (req, res) => {
  const userId = req.session.userId!;
  try {
    const result = await syncCorpStructures(userId, { force: true });
    return res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) { log.error('refresh failed', err); return res.status(500).json({ error: 'Refresh failed' }); }
});
