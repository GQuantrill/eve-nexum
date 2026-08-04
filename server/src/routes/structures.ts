import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { syncCorpStructures } from '../services/structureSync.js';

// Corp structures for the jump planner. GET lists what's cached for the caller's
// corp; POST /refresh re-pulls from ESI (role- and scope-gated inside the sync).
const log = createLogger('structures');
export const structuresRouter = Router();
structuresRouter.use(requireAuth);

// GET /api/structures — the caller's corp structures, joined to the SDE for the
// containing system's name + class (so the client can flag non-LS/NS ones).
structuresRouter.get('/', async (req, res) => {
  const userId = req.session.userId!;
  try {
    const { rows: ur } = await db.query<{ corp_id: number | null }>(
      `SELECT corp_id FROM users WHERE id = $1`, [userId],
    );
    const corpId = ur[0]?.corp_id;
    if (!corpId) return res.json([]);
    const { rows } = await db.query(
      `SELECT s.structure_id AS "structureId", s.name, s.type_name AS "typeName",
              s.solar_system_id AS "solarSystemId", ss.name AS "systemName", ss.class AS "systemClass"
         FROM structures s
         LEFT JOIN solar_systems ss ON ss.id = s.solar_system_id
        WHERE s.corporation_id = $1
        ORDER BY s.name`,
      [corpId],
    );
    return res.json(rows);
  } catch (err) { log.error('list failed', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// POST /api/structures/refresh — sync from ESI. Non-'ok' non-'error' outcomes
// (no_corp / no_role / needs_reauth) are 200s carrying a status the UI explains.
structuresRouter.post('/refresh', async (req, res) => {
  const userId = req.session.userId!;
  try {
    const result = await syncCorpStructures(userId);
    return res.status(result.status === 'error' ? 502 : 200).json(result);
  } catch (err) { log.error('refresh failed', err); return res.status(500).json({ error: 'Refresh failed' }); }
});
