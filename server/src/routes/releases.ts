import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { getRecentReleases } from '../services/releases.js';

const router = Router();
router.use(requireAuth);

// GET /api/releases — the last 10 upstream releases (patch notes). Cached
// server-side; any authenticated user can read it.
router.get('/', async (_req, res) => {
  res.json(await getRecentReleases());
});

export default router;
