import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { esiFetch } from '../utils/esi.js';
import { planJumpRoute, jumpGraphSize } from '../services/jumpGraph.js';

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

// Shattered systems (every planet is "Planet (Shattered)") drive the fragments
// icon on system nodes. Flagged on solar_systems.shattered by the SDE importer,
// so the set stays current across re-seeds. Same enrich-once-and-cache shape as
// the A0 list above.
interface ShatteredSystem { id: number; name: string; regionName: string }
let shatteredEnriched: ShatteredSystem[] | null = null;
let shatteredInflight: Promise<ShatteredSystem[]> | null = null;

// Drop the cached shattered list so the next request rebuilds it from the DB.
// Called after an SDE re-seed, which may have changed the shattered set.
export function resetShatteredCache(): void {
  shatteredEnriched = null;
  shatteredInflight = null;
}

async function loadShatteredEnriched(): Promise<ShatteredSystem[]> {
  if (shatteredEnriched) return shatteredEnriched;
  if (shatteredInflight) return shatteredInflight;
  shatteredInflight = (async () => {
    const { rows } = await db.query<{ id: number; name: string; region_name: string | null }>(
      `SELECT s.id, s.name, r.name AS region_name
         FROM solar_systems s
         LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.shattered`,
    );
    shatteredEnriched = rows.map(r => ({ id: r.id, name: r.name, regionName: r.region_name ?? '' }));
    shatteredInflight = null;
    return shatteredEnriched;
  })();
  return shatteredInflight;
}

// GET /api/systems/shattered — enriched list of shattered solar systems
systemsRouter.get('/shattered', async (_req, res) => {
  try {
    res.json(await loadShatteredEnriched());
  } catch (err) {
    log.error('Shattered enrichment failed:', err);
    res.status(500).json({ error: 'Shattered list unavailable' });
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

// GET /api/systems/:id/adjacent — k-space stargate neighbours of a system,
// powering the "Add adjacent" map context-menu. Pure static-SDE read against
// map_stargates (parameterized). Only k-space systems have stargates, so a
// wormhole system simply returns an empty array.
systemsRouter.get('/:id(\\d+)/adjacent', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query<{
      eveSystemId: number; name: string; security: string | null;
      systemClass: string | null; regionName: string | null;
    }>(
      `SELECT s.id       AS "eveSystemId",
              s.name     AS "name",
              s.security AS "security",
              s.class    AS "systemClass",
              r.name     AS "regionName"
         FROM map_stargates g
         JOIN solar_systems s      ON s.id = g.destination_system_id
         LEFT JOIN map_regions r   ON r.id = s.region_id
        WHERE g.system_id = $1
        GROUP BY s.id, s.name, s.security, s.class, r.name
        ORDER BY s.name`,
      [id],
    );
    return res.json(rows.map((row) => ({
      eveSystemId: row.eveSystemId,
      name:        row.name,
      security:    row.security != null ? Number(row.security) : null,
      systemClass: row.systemClass ?? null,
      regionName:  row.regionName ?? null,
    })));
  } catch (err) {
    log.error('Adjacent-systems query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/systems/:id/nearby-lawless?jumps=N — lowsec/nullsec systems within N
// gate-jumps of :id, for the voice announcer's "lawless in range" event. BFS over
// map_stargates (a recursive CTE), joined to solar_systems; security < 0.45 is
// below highsec (matches deriveClass). N clamped 0..5 (proximity ceiling). Only
// k-space has stargates, so a wormhole origin returns [].
systemsRouter.get('/:id(\\d+)/nearby-lawless', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const jumps = Math.max(0, Math.min(5, parseInt(String(req.query.jumps ?? '2'), 10) || 0));
  try {
    const { rows } = await db.query<{ id: number; name: string; security: string; jumps: number }>(
      `WITH RECURSIVE bfs(system_id, depth) AS (
         SELECT $1::int, 0
         UNION
         SELECT g.destination_system_id, b.depth + 1
           FROM bfs b JOIN map_stargates g ON g.system_id = b.system_id
          WHERE b.depth < $2
       )
       SELECT s.id, s.name, s.security::text AS security, MIN(b.depth)::int AS jumps
         FROM bfs b JOIN solar_systems s ON s.id = b.system_id
        WHERE b.system_id <> $1 AND s.security < 0.45
        GROUP BY s.id, s.name, s.security
        ORDER BY jumps, s.name`,
      [id, jumps],
    );
    return res.json(rows.map((r) => ({
      eveSystemId: r.id, name: r.name, security: Number(r.security), jumps: r.jumps,
    })));
  } catch (err) {
    log.error('nearby-lawless query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/systems/:id/jump-range?maxLy=N — every LS/NS k-space system within N
// light-years of :id (star-to-star, the metric jump drives use), for the jump-
// range overlay. Distance = 3D Euclidean over the SDE universe coords (metres)
// / metres-per-ly. Only lowsec + nullsec (jump drives don't work to highsec, and
// J-space/wormhole systems can't be jumped to). N clamped 0.1..20 (largest cap
// range at max skills is ~10 ly, so 20 is generous headroom). Ordered nearest-first.
const METRES_PER_LY = 9.4607e15;
systemsRouter.get('/:id(\\d+)/jump-range', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const maxLy = Math.max(0.1, Math.min(20, parseFloat(String(req.query.maxLy ?? '10')) || 10));
  try {
    // 3D coords come from the SDE (setup-db) or scripts/backfill-coords.ts. On a
    // deployment seeded before that, they're NULL — report it distinctly instead
    // of returning a misleading empty result, so the UI can prompt a backfill.
    const origin = await db.query<{ pos_x: number | null }>(
      'SELECT pos_x FROM solar_systems WHERE id = $1', [id],
    );
    if (!origin.rows[0] || origin.rows[0].pos_x == null) {
      return res.json({ hasCoords: false, systems: [] });
    }
    const { rows } = await db.query<{
      id: number; name: string; system_class: string; security: string; region_name: string | null; ly: string;
    }>(
      `WITH o AS (SELECT pos_x, pos_y, pos_z FROM solar_systems WHERE id = $1)
       SELECT s.id, s.name, s.class AS system_class, s.security::text AS security,
              r.name AS region_name,
              (sqrt(power(s.pos_x - o.pos_x, 2) + power(s.pos_y - o.pos_y, 2) + power(s.pos_z - o.pos_z, 2)) / $3)::text AS ly
         FROM solar_systems s
         CROSS JOIN o
         LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.id <> $1
          AND s.class IN ('LS','NS')
          AND s.pos_x IS NOT NULL AND o.pos_x IS NOT NULL
          AND sqrt(power(s.pos_x - o.pos_x, 2) + power(s.pos_y - o.pos_y, 2) + power(s.pos_z - o.pos_z, 2)) / $3 <= $2
        ORDER BY ly`,
      [id, maxLy, METRES_PER_LY],
    );
    return res.json({
      hasCoords: true,
      systems: rows.map((r) => ({
        eveSystemId: r.id,
        name: r.name,
        systemClass: r.system_class,
        security: Number(r.security),
        regionName: r.region_name ?? null,
        ly: Number(r.ly),
      })),
    });
  } catch (err) {
    log.error('jump-range query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/systems/:id/distance?to=N — light-years between two systems (star-to-
// star), for annotating a tagged cyno-jump connection. Null if either lacks coords.
systemsRouter.get('/:id(\\d+)/distance', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = parseInt(String(req.query.to ?? ''), 10);
  if (!to || to === id) return res.json({ ly: null });
  try {
    const { rows } = await db.query<{ ly: string | null }>(
      `SELECT (sqrt(power(a.pos_x - b.pos_x, 2) + power(a.pos_y - b.pos_y, 2) + power(a.pos_z - b.pos_z, 2)) / $3)::text AS ly
         FROM solar_systems a, solar_systems b
        WHERE a.id = $1 AND b.id = $2 AND a.pos_x IS NOT NULL AND b.pos_x IS NOT NULL`,
      [id, to, METRES_PER_LY],
    );
    return res.json({ ly: rows[0]?.ly != null ? Number(rows[0].ly) : null });
  } catch (err) {
    log.error('distance query failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/systems/jump-route?from=&to=&rangeLy=&objective=hops|fuel — plot a
// multi-hop capital/black-ops jump route between two LS/NS systems, where every
// hop is within rangeLy (the ship's max range). objective 'hops' = fewest jumps,
// 'fuel' = least total light-years. { hasCoords:false } when coords aren't loaded;
// route null = no path within range. Ship-agnostic — the client turns ship class
// + JDC into rangeLy and estimates fuel from the returned hop distances.
systemsRouter.get('/jump-route', async (req, res) => {
  const from = parseInt(String(req.query.from ?? ''), 10);
  const to   = parseInt(String(req.query.to ?? ''), 10);
  const rangeLy = Math.max(0.1, Math.min(20, parseFloat(String(req.query.rangeLy ?? '')) || 0));
  const objective = req.query.objective === 'fuel' ? 'fuel' : 'hops';
  if (!from || !to || !rangeLy) {
    return res.status(400).json({ error: 'from, to and rangeLy are required' });
  }
  try {
    if ((await jumpGraphSize()) === 0) return res.json({ hasCoords: false, route: null });
    const route = await planJumpRoute(from, to, rangeLy, objective);
    return res.json({ hasCoords: true, route });
  } catch (err) {
    log.error('jump-route failed:', err);
    return res.status(500).json({ error: 'Routing failed' });
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
      `SELECT s.id, s.name, s.security, s.class AS "systemClass",
              COALESCE(s.effect, 'none') AS effect, s.statics,
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
