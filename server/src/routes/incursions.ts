import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue } from '../utils/cache.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('incursions');

interface EsiFaction {
  faction_id: number;
  name: string;
  corporation_id?: number;
}

interface EsiIncursion {
  constellation_id:       number;
  faction_id:             number;
  has_boss:               boolean;
  infested_solar_systems: number[];
  influence:              number;
  staging_solar_system_id: number;
  state:                  string;
  type:                   string;
}

export interface IncursionSystem {
  systemId:       number;
  factionId:      number;
  factionName:    string;
  factionLogoUrl: string;
  state:          string;
  influence:      number;
  hasBoss:        boolean;
  isStaging:      boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

let factionMap: Map<number, EsiFaction> | null = null;
const cache = new TtlValue<IncursionSystem[]>(CACHE_TTL_MS);

async function loadFactions(): Promise<Map<number, EsiFaction>> {
  if (factionMap) return factionMap;
  const res = await esiFetch('https://esi.evetech.net/latest/universe/factions/?datasource=tranquility');
  if (!res.ok) throw new Error(`ESI factions ${res.status}`);
  const list = await res.json() as EsiFaction[];
  factionMap = new Map(list.map((f) => [f.faction_id, f]));
  return factionMap;
}

async function fetchAndBuild(): Promise<IncursionSystem[]> {
  const [incRes, factions] = await Promise.all([
    esiFetch('https://esi.evetech.net/latest/incursions/?datasource=tranquility'),
    loadFactions(),
  ]);
  if (!incRes.ok) throw new Error(`ESI incursions ${incRes.status}`);

  const incursions = await incRes.json() as EsiIncursion[];
  const result: IncursionSystem[] = [];

  for (const inc of incursions) {
    const faction = factions.get(inc.faction_id);
    const factionName    = faction?.name ?? 'Unknown';
    const factionLogoUrl = faction?.corporation_id
      ? `https://images.evetech.net/corporations/${faction.corporation_id}/logo?size=64`
      : '';

    for (const sysId of inc.infested_solar_systems) {
      result.push({
        systemId:       sysId,
        factionId:      inc.faction_id,
        factionName,
        factionLogoUrl,
        state:          inc.state,
        influence:      inc.influence,
        hasBoss:        inc.has_boss,
        isStaging:      sysId === inc.staging_solar_system_id,
      });
    }
  }
  return result;
}

router.get('/', async (_req, res) => {
  const fresh = cache.get();
  if (fresh) { res.json(fresh); return; }
  try {
    const data = await fetchAndBuild();
    cache.set(data);
    res.json(data);
  } catch (err) {
    log.error('Incursions fetch failed:', err);
    const stale = cache.getStale();
    if (stale) { res.json(stale); return; }
    res.status(502).json({ error: 'Failed to fetch incursions' });
  }
});

export default router;
