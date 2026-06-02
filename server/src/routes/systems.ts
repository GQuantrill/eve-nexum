import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { esiFetch } from '../utils/esi.js';

export const systemsRouter = Router();
const log = createLogger('systems');

const ESI = 'https://esi.evetech.net/latest';

// Static celestial metadata for the system-info panel. Served from the SDE
// columns on solar_systems (filled by setup-db); for an install that hasn't
// re-seeded since these columns were added, the counts are NULL and we fall
// back to live ESI once per system, caching the result for the process lifetime.
interface Celestials {
  securityStatus:    number | null;
  constellationName: string | null;
  sunType:           string | null;
  planetCount:       number;
  moonCount:         number;
  beltCount:         number;
  stargateCount:     number;
}

const celestialCache    = new Map<number, Celestials>();
const celestialInflight = new Map<number, Promise<Celestials | null>>();

// Resolve a star's typeID to its SDE name (e.g. "Sun K3 (Yellow Small)"),
// matching how setup-db stamps sun_type so the ESI fallback reads identically.
async function resolveSunTypeName(typeId: number): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM item_types WHERE id = $1`, [typeId]);
  return rows[0]?.name ?? null;
}

// Live-ESI fallback: one /universe/systems call for the counts + star_id, then
// one /universe/stars call for the sun type. security + constellation already
// came from our DB, so they're passed in rather than re-fetched.
async function fetchCelestialsFromEsi(
  id: number,
  base: { securityStatus: number | null; constellationName: string | null },
): Promise<Celestials | null> {
  try {
    const sysRes = await esiFetch(`${ESI}/universe/systems/${id}/?datasource=tranquility`);
    if (!sysRes.ok) return null;
    const sys = await sysRes.json() as {
      planets?: Array<{ moons?: number[]; asteroid_belts?: number[] }>;
      stargates?: number[];
      star_id?: number;
      security_status?: number;
    };
    let sunType: string | null = null;
    if (sys.star_id) {
      const starRes = await esiFetch(`${ESI}/universe/stars/${sys.star_id}/?datasource=tranquility`);
      if (starRes.ok) {
        const star = await starRes.json() as { type_id?: number; spectral_class?: string };
        sunType = star.type_id
          ? (await resolveSunTypeName(star.type_id)) ?? star.spectral_class ?? null
          : star.spectral_class ?? null;
      }
    }
    return {
      securityStatus:    base.securityStatus ?? sys.security_status ?? null,
      constellationName: base.constellationName,
      sunType,
      planetCount:   sys.planets?.length ?? 0,
      moonCount:     sys.planets?.reduce((n, p) => n + (p.moons?.length ?? 0), 0) ?? 0,
      beltCount:     sys.planets?.reduce((n, p) => n + (p.asteroid_belts?.length ?? 0), 0) ?? 0,
      stargateCount: sys.stargates?.length ?? 0,
    };
  } catch (err) {
    log.warn('ESI celestials fallback failed', err);
    return null;
  }
}

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

// GET /api/systems/:id/celestials — static celestial metadata for the panel
// (security, constellation, sun type, planet/moon/belt/gate counts). DB-first;
// live-ESI fallback (cached) only for systems not yet filled by a re-seed.
systemsRouter.get('/:id(\\d+)/celestials', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query<{
      securityStatus: string | null; sunType: string | null;
      planetCount: number | null; moonCount: number | null;
      beltCount: number | null; stargateCount: number | null;
      constellationName: string | null;
    }>(
      `SELECT s.security       AS "securityStatus",
              s.sun_type       AS "sunType",
              s.planet_count   AS "planetCount",
              s.moon_count     AS "moonCount",
              s.belt_count     AS "beltCount",
              s.stargate_count AS "stargateCount",
              c.name           AS "constellationName"
         FROM solar_systems s
         LEFT JOIN map_constellations c ON c.id = s.constellation_id
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'System not found' });

    const securityStatus    = row.securityStatus != null ? Number(row.securityStatus) : null;
    const constellationName = row.constellationName ?? null;

    // planet_count is the canary: importSolarSystems sets it for every system,
    // so a non-null value means this row was seeded and we serve from the DB.
    if (row.planetCount != null) {
      return res.json({
        securityStatus,
        constellationName,
        sunType:       row.sunType ?? null,
        planetCount:   row.planetCount,
        moonCount:     row.moonCount   ?? 0,
        beltCount:     row.beltCount    ?? 0,
        stargateCount: row.stargateCount ?? 0,
      } satisfies Celestials);
    }

    // Un-reseeded install: fill counts + sun type from ESI once, then cache.
    const cached = celestialCache.get(id);
    if (cached) return res.json(cached);
    let inflight = celestialInflight.get(id);
    if (!inflight) {
      inflight = fetchCelestialsFromEsi(id, { securityStatus, constellationName })
        .finally(() => celestialInflight.delete(id));
      celestialInflight.set(id, inflight);
    }
    const result = await inflight;
    if (!result) return res.status(502).json({ error: 'Celestials unavailable' });
    celestialCache.set(id, result);
    return res.json(result);
  } catch (err) {
    log.error('Celestials query failed:', err);
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
