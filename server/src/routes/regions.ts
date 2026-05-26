import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const regionsRouter = Router();
regionsRouter.use(requireAuth);

// GET /api/regions — region list for the create-map region picker.
//
// Limited to K-space regions (id < 11000000): wormhole / abyssal regions have
// no stargate topology to lay out, so seeding a "region map" from them would
// produce disconnected nodes. `positionedCount` lets the UI flag regions whose
// coordinates haven't been backfilled yet.
regionsRouter.get('/', async (_req, res) => {
  const { rows } = await db.query<{
    id: number; name: string; systemCount: number; positionedCount: number;
  }>(`
    SELECT r.id,
           r.name,
           COUNT(s.id)::int                                    AS "systemCount",
           COUNT(s.id) FILTER (WHERE s.pos_x IS NOT NULL)::int AS "positionedCount"
      FROM map_regions r
      JOIN solar_systems s ON s.region_id = r.id
     WHERE r.id < 11000000
     GROUP BY r.id, r.name
     ORDER BY r.name
  `);
  res.json({ regions: rows });
});
