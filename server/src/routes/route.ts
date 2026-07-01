import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { shortestRoutes, type RouteMode } from '../services/routeGraph.js';
import { buildRouteOverlay } from '../services/routeOverlay.js';
import { getMapAccess } from './maps.js';

const router = Router();
router.use(requireAuth);
const log = createLogger('route');

// BFS/Dijkstra are O(V+E) regardless of target count — extra targets
// just add early-termination checks. The cap exists purely to bound
// URL length (each ID is 8-9 chars) and prevent abuse. Proximity-alerts
// fans out across every hostile-sov system, which can run into the
// hundreds for users with wide negative-standing contact lists.
const MAX_TARGETS = 2000;
const VALID_MODES = new Set<RouteMode>(['shortest', 'secure']);

// GET /api/route?from=<systemId>&to=<id1>,<id2>,...&mode=shortest|secure
// Returns { [targetId]: { jumps, path } } for each reachable target.
router.get('/', async (req, res) => {
  const from = Number(req.query.from);
  if (!Number.isInteger(from) || from <= 0) {
    return res.status(400).json({ error: 'Invalid "from"' });
  }

  const toRaw = String(req.query.to ?? '').trim();
  if (!toRaw) return res.json({});

  const targets = toRaw.split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);

  if (targets.length === 0) return res.json({});
  if (targets.length > MAX_TARGETS) {
    return res.status(400).json({ error: `Too many targets (max ${MAX_TARGETS})` });
  }

  const modeRaw = String(req.query.mode ?? 'shortest') as RouteMode;
  const mode: RouteMode = VALID_MODES.has(modeRaw) ? modeRaw : 'shortest';

  // Optional shortcut edges spliced into the graph (opt-in per request).
  const includeThera     = String(req.query.includeThera)     === 'true';
  const includeTurnur    = String(req.query.includeTurnur)    === 'true';
  const includeWormholes = String(req.query.includeWormholes) === 'true';
  const includeAnsiblex  = String(req.query.includeAnsiblex)  === 'true';
  const mapId = typeof req.query.mapId === 'string' ? req.query.mapId : undefined;

  // Wormhole / Ansiblex edges come from a specific map — require it and enforce
  // access. Fail loudly rather than silently returning a gates-only route,
  // which would mislead the user into thinking no shortcut route exists.
  if (includeWormholes || includeAnsiblex) {
    if (!mapId) return res.status(400).json({ error: 'mapId required for map-based shortcuts' });
    const access = await getMapAccess(mapId, req);
    if (!access) return res.status(404).json({ error: 'Map not found' });
  }

  try {
    const overlay = (includeThera || includeTurnur || includeWormholes || includeAnsiblex)
      ? await buildRouteOverlay({ thera: includeThera, turnur: includeTurnur, wormholes: includeWormholes, ansiblex: includeAnsiblex, mapId })
      : undefined;
    const result = await shortestRoutes(from, targets, mode, overlay);
    return res.json(result);
  } catch (err) {
    log.error('Route compute failed:', err);
    return res.status(500).json({ error: 'Route computation failed' });
  }
});

export default router;
