import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const systemsRouter = Router();
const log = createLogger('systems');

// Static list of solar systems with A0-class stars (extracted from the SDE
// once and committed to data/). Never changes within a server's lifetime.
const A0_PATH = join(process.cwd(), 'data', 'a0-systems.json');
let a0SystemIds: number[] = [];
try {
  a0SystemIds = JSON.parse(readFileSync(A0_PATH, 'utf8')) as number[];
  log.info(`Loaded ${a0SystemIds.length} A0 system IDs`);
} catch (err) {
  log.error('Failed to load A0 system list:', err);
}

interface A0System { id: number; name: string; regionName: string }
let a0Enriched: A0System[] | null = null;
let a0Inflight: Promise<A0System[]> | null = null;

async function loadA0Enriched(): Promise<A0System[]> {
  if (a0Enriched) return a0Enriched;
  if (a0Inflight) return a0Inflight;
  a0Inflight = (async () => {
    const { rows } = await db.query<{ id: number; name: string; region_name: string | null }>(
      `SELECT s.id, s.name, r.name AS region_name
         FROM solar_systems s
         LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.id = ANY($1::int[])`,
      [a0SystemIds],
    );
    a0Enriched = rows.map(r => ({ id: r.id, name: r.name, regionName: r.region_name ?? '' }));
    a0Inflight = null;
    return a0Enriched;
  })();
  return a0Inflight;
}

// GET /api/systems/a0 — enriched list of A0-class solar systems
systemsRouter.get('/a0', async (_req, res) => {
  try {
    res.json(await loadA0Enriched());
  } catch (err) {
    log.error('A0 enrichment failed:', err);
    res.status(500).json({ error: 'A0 list unavailable' });
  }
});

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
