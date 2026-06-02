import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ghost-sites');

// Sig names always end with this phrase, e.g.
// "Superior Blood Raider Covert Research Facility".
const NAME_SUFFIX = 'Covert Research Facility';

// K-space only — the user is investigating cluster spawns; wormhole space
// is out of scope. 'HS' | 'LS' | 'NS' is what map_systems.system_class
// stores; everything else (C1-C6, Thera, Pochven, Drifter) is rejected.
const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS']);

interface SystemMeta {
  eveSystemId: number;
  systemName:  string;
  systemClass: string;
}

// Fire-and-forget. Called after a signature insert/update. Bails silently
// on anything unexpected — this is observational data, not load-bearing.
export function recordGhostSiteIfMatch(systemUuid: string, sigName: string | undefined | null): void {
  if (!sigName || !sigName.trim().endsWith(NAME_SUFFIX)) return;
  void runDetection(systemUuid).catch((err) => log.error('detection failed', err));
}

async function runDetection(systemUuid: string): Promise<void> {
  const meta = await loadSystemMeta(systemUuid);
  if (!meta) return;
  if (!KSPACE_CLASSES.has(meta.systemClass)) return;

  // Bump observations + last_seen if we've already cataloged this system.
  const bumped = await db.query(
    `UPDATE ghost_site_systems
        SET observations = observations + 1,
            last_seen_at = NOW()
      WHERE eve_system_id = $1`,
    [meta.eveSystemId],
  );
  if ((bumped.rowCount ?? 0) > 0) return;

  // First sighting — resolve static metadata. Constellation/region come
  // from the local SDE; star type + planet/moon counts come from ESI
  // (one-off per system, results are immutable so caching is forever).
  const [scope, esi] = await Promise.all([
    loadConstellationRegion(meta.eveSystemId),
    fetchEsiSystemInfo(meta.eveSystemId),
  ]);
  const sunType = esi?.starId ? await resolveSunType(esi.starId) : null;

  await db.query(
    `INSERT INTO ghost_site_systems
       (eve_system_id, system_name, constellation_name, region_name,
        system_class, sun_type, planet_count, moon_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (eve_system_id) DO UPDATE SET
       observations = ghost_site_systems.observations + 1,
       last_seen_at = NOW()`,
    [
      meta.eveSystemId,
      meta.systemName,
      scope?.constellation ?? null,
      scope?.region ?? null,
      meta.systemClass,
      sunType,
      esi?.planetCount ?? null,
      esi?.moonCount ?? null,
    ],
  );
}

async function loadSystemMeta(systemUuid: string): Promise<SystemMeta | null> {
  const { rows } = await db.query<{ eve_system_id: number | null; name: string; system_class: string }>(
    `SELECT eve_system_id, name, system_class
       FROM map_systems WHERE id = $1`,
    [systemUuid],
  );
  const row = rows[0];
  if (!row || row.eve_system_id == null) return null;
  return { eveSystemId: row.eve_system_id, systemName: row.name, systemClass: row.system_class };
}

async function loadConstellationRegion(eveSystemId: number): Promise<{ constellation: string; region: string } | null> {
  const { rows } = await db.query<{ constellation: string; region: string }>(
    `SELECT c.name AS constellation, r.name AS region
       FROM solar_systems s
       JOIN map_constellations c ON c.id = s.constellation_id
       JOIN map_regions        r ON r.id = s.region_id
      WHERE s.id = $1`,
    [eveSystemId],
  );
  return rows[0] ?? null;
}

interface EsiSystemInfo {
  starId:      number | null;
  planetCount: number;
  moonCount:   number;
}

async function fetchEsiSystemInfo(eveSystemId: number): Promise<EsiSystemInfo | null> {
  try {
    const res = await esiFetch(`https://esi.evetech.net/latest/universe/systems/${eveSystemId}/?datasource=tranquility`);
    if (!res.ok) return null;
    const json = await res.json() as { star_id?: number; planets?: Array<{ planet_id: number; moons?: number[] }> };
    const planets = Array.isArray(json.planets) ? json.planets : [];
    const moonCount = planets.reduce((sum, p) => sum + (Array.isArray(p.moons) ? p.moons.length : 0), 0);
    return { starId: json.star_id ?? null, planetCount: planets.length, moonCount };
  } catch (err) {
    log.warn('ESI systems lookup failed', { eveSystemId, err });
    return null;
  }
}

async function resolveSunType(starId: number): Promise<string | null> {
  try {
    const res = await esiFetch(`https://esi.evetech.net/latest/universe/stars/${starId}/?datasource=tranquility`);
    if (!res.ok) return null;
    const json = await res.json() as { type_id?: number; spectral_class?: string };
    if (!json.type_id) return json.spectral_class ?? null;
    // Prefer the SDE name (e.g. "Sun K8 (Orange Dwarf)") over the bare
    // spectral class, falling back to whatever ESI returned.
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM item_types WHERE id = $1`,
      [json.type_id],
    );
    return rows[0]?.name ?? json.spectral_class ?? null;
  } catch (err) {
    log.warn('ESI stars lookup failed', { starId, err });
    return null;
  }
}
