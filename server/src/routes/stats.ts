import { Router } from 'express';
import { db } from '../db.js';
import { optionalAuth } from '../middleware/optionalAuth.js';

const router = Router();
router.use(optionalAuth);

const SIG_TYPES = ['data', 'relic', 'gas', 'ore', 'combat', 'wormhole', 'unknown'] as const;
type SigType = typeof SIG_TYPES[number];

interface PeriodStats {
  jumps: number;
  signatures: { total: number } & Record<SigType, number>;
}

function emptyPeriod(): PeriodStats {
  return {
    jumps: 0,
    signatures: { total: 0, data: 0, relic: 0, gas: 0, ore: 0, combat: 0, wormhole: 0, unknown: 0 },
  };
}

type PeriodKey = 'forever' | 'year' | 'month' | 'week' | 'day';
const PERIODS: PeriodKey[] = ['forever', 'year', 'month', 'week', 'day'];

router.get('/', async (req, res) => {
  const userId = req.session.userId!;

  const now   = new Date();
  const day   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week  = new Date(now.getTime() - 7   * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000);
  const year  = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const bucketParams = [userId, year, month, week, day];

  // Two parallel queries:
  //   jumps  — append-only log in user_events; deleting a sig doesn't roll
  //            jumps back, so we keep using the event log
  //   sigs   — live count from map_signatures, so deletions are reflected.
  //            Rows older than the created_by_user_id migration carry NULL
  //            and won't attribute to anyone (acceptable).
  const [jumpRes, sigRes] = await Promise.all([
    db.query<{ forever: string; year: string; month: string; week: string; day: string }>(
      `SELECT
         COUNT(*)::text                                  AS forever,
         COUNT(*) FILTER (WHERE created_at >= $2)::text AS year,
         COUNT(*) FILTER (WHERE created_at >= $3)::text AS month,
         COUNT(*) FILTER (WHERE created_at >= $4)::text AS week,
         COUNT(*) FILTER (WHERE created_at >= $5)::text AS day
       FROM user_events
       WHERE user_id = $1 AND event_type = 'jump'`,
      bucketParams,
    ),
    db.query<{ sig_type: string | null; forever: string; year: string; month: string; week: string; day: string }>(
      `SELECT
         sig_type,
         COUNT(*)::text                                  AS forever,
         COUNT(*) FILTER (WHERE created_at >= $2)::text AS year,
         COUNT(*) FILTER (WHERE created_at >= $3)::text AS month,
         COUNT(*) FILTER (WHERE created_at >= $4)::text AS week,
         COUNT(*) FILTER (WHERE created_at >= $5)::text AS day
       FROM map_signatures
       WHERE created_by_user_id = $1
       GROUP BY sig_type`,
      bucketParams,
    ),
  ]);

  const result: Record<PeriodKey, PeriodStats> = {
    forever: emptyPeriod(),
    year:    emptyPeriod(),
    month:   emptyPeriod(),
    week:    emptyPeriod(),
    day:     emptyPeriod(),
  };

  const j = jumpRes.rows[0];
  if (j) {
    for (const p of PERIODS) result[p].jumps = parseInt(j[p], 10);
  }

  for (const row of sigRes.rows) {
    const counts: Record<PeriodKey, number> = {
      forever: parseInt(row.forever, 10),
      year:    parseInt(row.year,    10),
      month:   parseInt(row.month,   10),
      week:    parseInt(row.week,    10),
      day:     parseInt(row.day,     10),
    };
    const t = (row.sig_type ?? 'unknown') as SigType;
    const bucket: SigType = SIG_TYPES.includes(t) ? t : 'unknown';
    for (const p of PERIODS) {
      result[p].signatures.total  += counts[p];
      result[p].signatures[bucket] += counts[p];
    }
  }

  res.json(result);
});

export default router;
