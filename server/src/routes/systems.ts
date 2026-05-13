import { Router } from 'express';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const systemsRouter = Router();
const log = createLogger('systems');

// GET /api/systems/search?q=<query>
systemsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.security, s.class AS "systemClass",
              r.name AS "regionName", r.npc_type AS "npcType"
       FROM solar_systems s
       LEFT JOIN map_regions r ON r.id = s.region_id
       WHERE s.name ILIKE $1
       ORDER BY
         CASE WHEN LOWER(s.name) = LOWER($2) THEN 0 ELSE 1 END,
         s.name
       LIMIT 15`,
      [`${q}%`, q],
    );
    return res.json(rows);
  } catch (err) {
    log.error('Query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/systems/:id
systemsRouter.get('/:id(\\d+)', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.security, s.class AS "systemClass", s.effect, s.statics,
              r.name AS "regionName", r.npc_type AS "npcType"
       FROM solar_systems s
       LEFT JOIN map_regions r ON r.id = s.region_id
       WHERE s.id = $1`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: 'System not found' });
    return res.json(rows[0]);
  } catch (err) {
    log.error('Query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});
