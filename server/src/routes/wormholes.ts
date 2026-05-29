import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
const log = createLogger('wormholes');

// Wormhole stats are derived live from the SDE we've already imported: CCP
// encodes them as dogma attributes on the "Wormhole XXX" item types, so a CCP
// rebalance flows in automatically on the next SDE re-seed — no file edit, no
// rebuild. The one thing CCP does NOT encode is `src` ("where can this WH
// appear"), which is community knowledge; that stays curated in
// data/wormholes.json and is merged in here by code. (static / sibling_groups
// live in that file too but aren't served by this endpoint.)
const ATTR = { destClass: 1381, totalMass: 1382, maxJumpable: 1383, massRegen: 1384, maxTime: 1503 };

// CCP's wormholeTargetSystemClass values → our destination codes.
const CLASS_MAP: Record<number, string> = {
  1: 'c1', 2: 'c2', 3: 'c3', 4: 'c4', 5: 'c5', 6: 'c6',
  7: 'hs', 8: 'ls', 9: 'ns',
  12: 'thera', 13: 'c13',
  14: 'drifter', 15: 'drifter', 16: 'drifter', 17: 'drifter', 18: 'drifter',
  25: 'pochven',
};

// Curated, non-derivable fields, keyed by WH code. Also the fallback source for
// codes that aren't in dogma at all (e.g. K162, the generic "return side").
interface CuratedSpec {
  src?:               string[] | null;
  total_mass?:        number | null;
  max_mass_per_jump?: number | null;
  mass_regen?:        number | null;
  lifetime?:          number | null;
  dest?:              string | null;
}

export interface WormholeSpec {
  totalMass:      number; // kg
  maxJumpMass:    number; // kg
  massRegen:      number; // kg/hour
  lifetimeHours:  number;
  dest:           string;
  src:            string[];
}

function loadCurated(): Record<string, CuratedSpec> {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), 'data', 'wormholes.json'), 'utf8'),
    ) as Record<string, CuratedSpec>;
  } catch (err) {
    log.error('Failed to load curated data/wormholes.json:', err);
    return {};
  }
}

let cache: Record<string, WormholeSpec> | null = null;
let inflight: Promise<Record<string, WormholeSpec>> | null = null;

// Drop the cached specs so the next request rebuilds them from the DB. Called
// after an SDE re-seed, which may have changed WH dogma values or added types.
export function resetWormholeCache(): void {
  cache = null;
  inflight = null;
}

async function loadSpecs(): Promise<Record<string, WormholeSpec>> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const curated = loadCurated();

    const { rows } = await db.query<{
      name:         string;
      dest_class:   string | null;
      total_mass:   string | null;
      max_jumpable: string | null;
      mass_regen:   string | null;
      max_time:     string | null;
    }>(`
      SELECT
        t.name,
        MAX(CASE WHEN d.attribute_id = ${ATTR.destClass}   THEN d.value END) AS dest_class,
        MAX(CASE WHEN d.attribute_id = ${ATTR.totalMass}   THEN d.value END) AS total_mass,
        MAX(CASE WHEN d.attribute_id = ${ATTR.maxJumpable} THEN d.value END) AS max_jumpable,
        MAX(CASE WHEN d.attribute_id = ${ATTR.massRegen}   THEN d.value END) AS mass_regen,
        MAX(CASE WHEN d.attribute_id = ${ATTR.maxTime}     THEN d.value END) AS max_time
      FROM item_types t
      LEFT JOIN item_dogma_attributes d ON d.type_id = t.id
      WHERE t.name ~ '^Wormhole [A-Z][0-9]{3}$'
      GROUP BY t.id, t.name
      HAVING MAX(CASE WHEN d.attribute_id = ${ATTR.destClass} THEN d.value END) IS NOT NULL
      ORDER BY t.name
    `);

    const out: Record<string, WormholeSpec> = {};
    const newCodes: string[] = [];
    const unmapped: string[] = [];

    for (const row of rows) {
      const code = row.name.replace(/^Wormhole\s+/, '');
      const destNum = row.dest_class != null ? Math.round(parseFloat(row.dest_class)) : null;
      const dest = destNum != null ? CLASS_MAP[destNum] : null;
      if (!dest) { unmapped.push(`${code} (dest_class=${row.dest_class})`); continue; }

      const cur = curated[code];
      if (!cur) newCodes.push(code);

      out[code] = {
        totalMass:     Math.round(parseFloat(row.total_mass   ?? '0')),
        maxJumpMass:   Math.round(parseFloat(row.max_jumpable ?? '0')),
        massRegen:     Math.round(parseFloat(row.mass_regen   ?? '0')),
        lifetimeHours: row.max_time != null
                         ? Math.round(parseFloat(row.max_time) / 3600)
                         : cur?.lifetime ?? 0,
        dest,
        src:           cur?.src ?? [],
      };
    }

    // Curated codes that aren't in dogma (e.g. K162, the generic "return side")
    // — serve them from the file verbatim, preserving the exact shape the old
    // file-only loader emitted (null stat fields pass through unchanged).
    for (const [code, spec] of Object.entries(curated)) {
      if (out[code]) continue;
      out[code] = {
        totalMass:     spec.total_mass as number,
        maxJumpMass:   spec.max_mass_per_jump as number,
        massRegen:     spec.mass_regen ?? 0,
        lifetimeHours: spec.lifetime as number,
        dest:          spec.dest as string,
        src:           spec.src ?? [],
      };
    }

    log.info(`Loaded ${Object.keys(out).length} wormhole type specs (derived from SDE dogma + curated src)`);
    if (newCodes.length) {
      log.warn(`${newCodes.length} WH code(s) in the SDE have no curated src yet (showing with src: []): ${newCodes.join(', ')}`);
    }
    if (unmapped.length) {
      log.warn(`${unmapped.length} WH type(s) have an unmapped destination class (skipped): ${unmapped.join(', ')}`);
    }

    cache = out;
    inflight = null;
    return out;
  })();
  return inflight;
}

router.get('/types', async (_req, res) => {
  try {
    res.json(await loadSpecs());
  } catch (err) {
    log.error('Failed to build wormhole specs:', err);
    res.status(500).json({ error: 'Wormhole specs unavailable' });
  }
});

export default router;
