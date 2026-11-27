import { Router } from 'express';
import { buildUsageReport, usageShareValid, type UsageReport } from '../services/usageStats.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('usage');

// GET /api/usage/:token -- the usage page behind its shareable link (made in
// the admin Reports tab). No sign-in: the link is the key.
export const usageRouter = Router();

// The report reads GA and every install's history, so share one copy for a
// few minutes rather than rebuilding it per viewer.
let cached: { at: number; report: UsageReport } | null = null;
export async function cachedUsageReport(): Promise<UsageReport> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.report;
  const report = await buildUsageReport();
  cached = { at: Date.now(), report };
  return report;
}

usageRouter.get('/:token', async (req, res) => {
  if (!(await usageShareValid(req.params.token))) { res.status(404).json({ error: 'not found' }); return; }
  try {
    res.json({ report: await cachedUsageReport() });
  } catch (err) {
    log.error('usage report failed:', err);
    res.status(500).json({ error: 'report failed' });
  }
});
