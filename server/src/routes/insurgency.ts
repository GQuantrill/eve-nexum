import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue, cachedJsonHandler } from '../utils/cache.js';
import { loadFactions, factionLogoUrl } from '../utils/esiFactions.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('insurgency');

interface SolarSystemEntry {
  id:              number;
  name:            string;
  security:        number;
  securityBand:    string;
  ownerFactionId:  number;
  occupierFactionId: number | null;
}

interface InsurgencyEntry {
  corruptionDate:        string | null;
  corruptionPercentage:  number;
  corruptionState:       number;
  suppressionDate:       string | null;
  suppressionPercentage: number;
  suppressionState:      number;
  solarSystem:           SolarSystemEntry;
}

interface Campaign {
  campaignId:     number;
  pirateFactionId: number;
  state:          string;
  insurgencies:   InsurgencyEntry[];
}

export interface InsurgencySystem {
  systemId:         number;
  campaignId:       number;
  factionId:        number;
  factionName:      string;
  factionLogoUrl:   string;
  corruptionPct:    number;
  corruptionState:  number;
  suppressionPct:   number;
  suppressionState: number;
}

const cache = new TtlValue<InsurgencySystem[]>(60 * 60 * 1000);

async function fetchAndBuild(): Promise<InsurgencySystem[]> {
  const [warzoneRes, factions] = await Promise.all([
    fetch('https://www.eveonline.com/api/warzone/insurgency'),
    loadFactions(),
  ]);
  if (!warzoneRes.ok) throw new Error(`Warzone API ${warzoneRes.status}`);

  const campaigns = await warzoneRes.json() as Campaign[];
  const result: InsurgencySystem[] = [];

  for (const campaign of campaigns) {
    if (campaign.state !== 'ACTIVE') continue;
    const faction = factions.get(campaign.pirateFactionId);
    const factionName = faction?.name ?? 'Unknown';
    const logoUrl     = factionLogoUrl(faction);

    for (const ins of campaign.insurgencies) {
      result.push({
        systemId:         ins.solarSystem.id,
        campaignId:       campaign.campaignId,
        factionId:        campaign.pirateFactionId,
        factionName,
        factionLogoUrl:   logoUrl,
        corruptionPct:    ins.corruptionPercentage,
        corruptionState:  ins.corruptionState,
        suppressionPct:   ins.suppressionPercentage,
        suppressionState: ins.suppressionState,
      });
    }
  }

  return result;
}

router.get('/', cachedJsonHandler(cache, fetchAndBuild, {
  log, logMsg: 'Insurgency fetch failed:', errorMsg: 'Failed to fetch insurgency data',
}));

export default router;
