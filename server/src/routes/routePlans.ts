import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { resolveOwnerId } from '../utils/owner.js';
import { createLogger } from '../utils/logger.js';

// Saved gate routes for the Route Planner pane, account-scoped (shared across an
// account's alts), mirroring jumpPlans.ts.
//
// Stores the two endpoints only. The route is recomputed on load via /api/route,
// so a saved plan always reflects the chain and scout connections as they stand
// now -- storing the computed path would hand the pilot a route through holes
// that rolled days ago.
const log = createLogger('routePlans');
export const routePlansRouter = Router();
routePlansRouter.use(requireAuth);

interface PlanRow {
  id: string; name: string; fromEveId: number; toEveId: number;
  fromName: string | null; toName: string | null;
}

// GET /api/route-plans — the account's saved routes, newest first.
routePlansRouter.get('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { rows } = await db.query<PlanRow>(
      `SELECT rp.id, rp.name, rp.from_eve_id AS "fromEveId", rp.to_eve_id AS "toEveId",
              sf.name AS "fromName", st.name AS "toName"
         FROM route_plans rp
         LEFT JOIN solar_systems sf ON sf.id = rp.from_eve_id
         LEFT JOIN solar_systems st ON st.id = rp.to_eve_id
        WHERE rp.owner_id = $1
        ORDER BY rp.created_at DESC`,
      [owner],
    );
    return res.json(rows);
  } catch (err) { log.error('list failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// POST /api/route-plans — save a route { name, fromEveId, toEveId }.
routePlansRouter.post('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const from = parseInt(String(body.fromEveId), 10);
  const to   = parseInt(String(body.toEveId), 10);
  if (!name || !Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
    return res.status(400).json({ error: 'name, fromEveId, toEveId required' });
  }
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });
  try {
    const id = randomUUID();
    await db.query(
      `INSERT INTO route_plans (id, owner_id, name, from_eve_id, to_eve_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, owner, name, from, to],
    );
    return res.json({ id });
  } catch (err) { log.error('save failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// DELETE /api/route-plans/:id — remove one of the account's saved routes. The
// owner_id predicate is the access check: another account's id simply matches
// no row rather than deleting someone else's plan.
routePlansRouter.delete('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await db.query(`DELETE FROM route_plans WHERE id = $1 AND owner_id = $2`, [req.params.id, owner]);
    return res.json({ ok: true });
  } catch (err) { log.error('delete failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});
