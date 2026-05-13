import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { shortestRoutes } from '../services/routeGraph.js';

const router = Router();
router.use(requireAuth);
const log = createLogger('route');

const MAX_TARGETS = 500;

// GET /api/route?from=<systemId>&to=<id1>,<id2>,...
// Returns { [targetId]: jumps } for each reachable target.
router.get('/', (req, res) => {
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

  try {
    const result = shortestRoutes(from, targets);
    return res.json(result);
  } catch (err) {
    log.error('Route compute failed:', err);
    return res.status(500).json({ error: 'Route computation failed' });
  }
});

export default router;
