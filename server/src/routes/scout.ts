import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue, cachedJsonHandler } from '../utils/cache.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('scout');

export interface ScoutConnection {
  id:             string;
  whType:         string;
  maxShipSize:    string;
  expiresAt:      string;
  remainingHours: number;
  outSystemId:    number;
  outSystemName:  string;
  outSignature:   string;
  inSystemId:     number;
  inSystemName:   string;
  inSystemClass:  string | null;
  inRegionId:     number;
  inRegionName:   string;
  inSignature:    string;
  whExitsOutward: boolean;
}

interface RawScoutEntry {
  id:                 string;
  wh_type:            string;
  max_ship_size:      string;
  expires_at:         string;
  remaining_hours:    number;
  signature_type:     string;
  out_system_id:      number;
  out_system_name:    string;
  out_signature:      string;
  in_system_id:       number;
  in_system_name:     string;
  in_system_class:    string | null;
  in_region_id:       number;
  in_region_name:     string;
  in_signature:       string;
  wh_exits_outward:   boolean;
  completed:          boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — eve-scout updates frequently
const cache = new TtlValue<ScoutConnection[]>(CACHE_TTL_MS);

async function fetchAndBuild(): Promise<ScoutConnection[]> {
  const res = await fetch('https://api.eve-scout.com/v2/public/signatures');
  if (!res.ok) throw new Error(`eve-scout ${res.status}`);
  const list = await res.json() as RawScoutEntry[];
  return list
    .filter(r => r.signature_type === 'wormhole')
    .map(r => ({
      id:             r.id,
      whType:         r.wh_type,
      maxShipSize:    r.max_ship_size,
      expiresAt:      r.expires_at,
      remainingHours: r.remaining_hours,
      outSystemId:    r.out_system_id,
      outSystemName:  r.out_system_name,
      outSignature:   r.out_signature,
      inSystemId:     r.in_system_id,
      inSystemName:   r.in_system_name,
      inSystemClass:  r.in_system_class,
      inRegionId:     r.in_region_id,
      inRegionName:   r.in_region_name,
      inSignature:    r.in_signature,
      whExitsOutward: r.wh_exits_outward,
    }));
}

router.get('/', cachedJsonHandler(cache, fetchAndBuild, {
  log, logMsg: 'Scout fetch failed:', errorMsg: 'Failed to fetch scout signatures',
}));

export default router;
