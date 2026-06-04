import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue, cachedJsonHandler } from '../utils/cache.js';
import { loadFactions, factionLogoUrl } from '../utils/esiFactions.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('incursions');

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

const cache = new TtlValue<IncursionSystem[]>(60 * 60 * 1000);

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
    const factionName = faction?.name ?? 'Unknown';
    const logoUrl     = factionLogoUrl(faction);
    for (const sysId of inc.infested_solar_systems) {
      result.push({
        systemId:       sysId,
        factionId:      inc.faction_id,
        factionName,
        factionLogoUrl: logoUrl,
        state:          inc.state,
        influence:      inc.influence,
        hasBoss:        inc.has_boss,
        isStaging:      sysId === inc.staging_solar_system_id,
      });
    }
  }
  return result;
}

router.get('/', cachedJsonHandler(cache, fetchAndBuild, {
  log, logMsg: 'Incursions fetch failed:', errorMsg: 'Failed to fetch incursions',
}));

export default router;
