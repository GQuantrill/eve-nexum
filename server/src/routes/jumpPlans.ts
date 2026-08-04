import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { resolveOwnerId } from '../utils/owner.js';
import { createLogger } from '../utils/logger.js';

// Saved jump-planner routes, account-scoped (shared across an account's alts).
// Stores the inputs only — the route is recomputed on load via /jump-route.
const log = createLogger('jumpPlans');
export const jumpPlansRouter = Router();
jumpPlansRouter.use(requireAuth);

interface PlanRow {
  id: string; name: string; fromEveId: number; toEveId: number; shipClass: string; objective: string;
  preferLevel: string | null; avoidIds: number[] | null; waypointIds: number[] | null;
  fromName: string | null; toName: string | null;
}
const toIntArr = (v: unknown, cap: number): number[] =>
  Array.isArray(v) ? v.map((x) => parseInt(String(x), 10)).filter(Boolean).slice(0, cap) : [];

// GET /api/jump-plans — the account's saved plans, newest first.
jumpPlansRouter.get('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { rows } = await db.query<PlanRow>(
      `SELECT jp.id, jp.name, jp.from_eve_id AS "fromEveId", jp.to_eve_id AS "toEveId",
              jp.ship_class AS "shipClass", jp.objective, jp.prefer_level AS "preferLevel",
              jp.avoid_system_ids AS "avoidIds", jp.waypoint_system_ids AS "waypointIds",
              sf.name AS "fromName", st.name AS "toName"
         FROM jump_plans jp
         LEFT JOIN solar_systems sf ON sf.id = jp.from_eve_id
         LEFT JOIN solar_systems st ON st.id = jp.to_eve_id
        WHERE jp.owner_id = $1
        ORDER BY jp.created_at DESC`,
      [owner],
    );
    // Resolve names for every avoid + waypoint system id across the plans.
    const allIds = [...new Set(rows.flatMap((r) => [...(r.avoidIds ?? []), ...(r.waypointIds ?? [])]))];
    const nameMap = new Map<number, string>();
    if (allIds.length) {
      const { rows: nr } = await db.query<{ id: number; name: string }>(
        `SELECT id, name FROM solar_systems WHERE id = ANY($1::int[])`, [allIds]);
      nr.forEach((n) => nameMap.set(n.id, n.name));
    }
    const toPairs = (ids: number[] | null) => (ids ?? []).map((id) => ({ id, name: nameMap.get(id) ?? String(id) }));
    return res.json(rows.map((r) => ({
      id: r.id, name: r.name, fromEveId: r.fromEveId, toEveId: r.toEveId, fromName: r.fromName, toName: r.toName,
      shipClass: r.shipClass, objective: r.objective, preferLevel: r.preferLevel ?? 'off',
      avoid: toPairs(r.avoidIds), waypoints: toPairs(r.waypointIds),
    })));
  } catch (err) { log.error('list failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// POST /api/jump-plans — save a plan { name, fromEveId, toEveId, shipClass, objective }.
jumpPlansRouter.post('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const from = parseInt(String(body.fromEveId), 10);
  const to   = parseInt(String(body.toEveId), 10);
  const ship = typeof body.shipClass === 'string' ? body.shipClass.slice(0, 24) : '';
  const objective = body.objective === 'fuel' ? 'fuel' : 'hops';
  const avoid = toIntArr(body.avoid, 200);
  const waypoints = toIntArr(body.waypoints, 20);
  const preferLevel = body.preferLevel === 'prefer' || body.preferLevel === 'strong' ? body.preferLevel : 'off';
  if (!name || !from || !to || !ship) {
    return res.status(400).json({ error: 'name, fromEveId, toEveId, shipClass required' });
  }
  try {
    const id = randomUUID();
    await db.query(
      `INSERT INTO jump_plans (id, owner_id, name, from_eve_id, to_eve_id, ship_class, objective,
                               avoid_system_ids, waypoint_system_ids, prefer_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, owner, name, from, to, ship, objective, avoid, waypoints, preferLevel],
    );
    return res.json({ id });
  } catch (err) { log.error('save failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// DELETE /api/jump-plans/:id — remove one of the account's plans.
jumpPlansRouter.delete('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await db.query(`DELETE FROM jump_plans WHERE id = $1 AND owner_id = $2`, [req.params.id, owner]);
    return res.json({ ok: true });
  } catch (err) { log.error('delete failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});
