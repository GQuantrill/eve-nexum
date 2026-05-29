import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

export const systemsRouter = Router();
const log = createLogger('systems');

// Solar systems with A0-class stars ("Sun A0 (Blue Small)", typeID 3801) drive
// the ★ icon on system nodes. The set is flagged on solar_systems.is_a0 by the
// SDE importer, so it stays current across SDE re-seeds. Enriched with names +
// region on first request and cached for the server's lifetime.
interface A0System { id: number; name: string; regionName: string }
let a0Enriched: A0System[] | null = null;
let a0Inflight: Promise<A0System[]> | null = null;

// Drop the cached A0 list so the next request rebuilds it from the DB. Called
// after an SDE re-seed, which may have changed which systems carry an A0 star.
export function resetA0Cache(): void {
  a0Enriched = null;
  a0Inflight = null;
}

async function loadA0Enriched(): Promise<A0System[]> {
  if (a0Enriched) return a0Enriched;
  if (a0Inflight) return a0Inflight;
  a0Inflight = (async () => {
    const { rows } = await db.query<{ id: number; name: string; region_name: string | null }>(
      `SELECT s.id, s.name, r.name AS region_name
         FROM solar_systems s
         LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.is_a0`,
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

// Solar systems that spawn ice anomalies. Committed as a list of names
// keyed by faction quarter so it's easy to maintain by hand; we resolve
// the names to eve_system_ids once at first request and cache forever
// (the list never changes mid-run). Null-sec coverage is intentionally
// absent for now — see the _note field in the JSON.
const ICE_PATH = join(process.cwd(), 'data', 'ice-belt-systems.json');
let iceBeltNames: string[] = [];
try {
  const raw = JSON.parse(readFileSync(ICE_PATH, 'utf8')) as Record<string, unknown>;
  iceBeltNames = Object.entries(raw)
    .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
    .flatMap(([, v]) => v as string[]);
  log.info(`Loaded ${iceBeltNames.length} ice-belt system names`);
} catch (err) {
  log.error('Failed to load ice-belt system list:', err);
}

let iceBeltIds: number[] | null = null;
let iceBeltInflight: Promise<number[]> | null = null;

async function loadIceBeltIds(): Promise<number[]> {
  if (iceBeltIds) return iceBeltIds;
  if (iceBeltInflight) return iceBeltInflight;
  iceBeltInflight = (async () => {
    if (iceBeltNames.length === 0) { iceBeltIds = []; iceBeltInflight = null; return []; }
    const { rows } = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM solar_systems WHERE name = ANY($1::text[])`,
      [iceBeltNames],
    );
    iceBeltIds = rows.map((r) => r.id);
    const unresolved = iceBeltNames.length - rows.length;
    if (unresolved > 0) {
      const got = new Set(rows.map((r) => r.name));
      const missing = iceBeltNames.filter((n) => !got.has(n));
      log.warn(`Ice-belt resolution: ${unresolved} unresolved name(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
    }
    iceBeltInflight = null;
    return iceBeltIds;
  })();
  return iceBeltInflight;
}

// GET /api/systems/ice-belts — flat array of eve_system_ids that spawn ice
systemsRouter.get('/ice-belts', async (_req, res) => {
  try {
    res.json(await loadIceBeltIds());
  } catch (err) {
    log.error('Ice-belt lookup failed:', err);
    res.status(500).json({ error: 'Ice-belt list unavailable' });
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
