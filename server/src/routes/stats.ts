import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();
router.use(requireAuth);

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

interface AggregatedRow {
  event_type: string;
  sig_type:   string | null;
  forever:    string;
  year:       string;
  month:      string;
  week:       string;
  day:        string;
}

router.get('/', async (req, res) => {
  const userId = req.session.userId!;

  const now   = new Date();
  const day   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week  = new Date(now.getTime() - 7   * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000);
  const year  = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  // One aggregate query — Postgres FILTER clauses give us all five buckets in
  // a single pass, replacing the previous "pull every event into JS" approach.
  const { rows } = await db.query<AggregatedRow>(
    `SELECT
       event_type,
       sig_type,
       COUNT(*)::text                                        AS forever,
       COUNT(*) FILTER (WHERE created_at >= $2)::text       AS year,
       COUNT(*) FILTER (WHERE created_at >= $3)::text       AS month,
       COUNT(*) FILTER (WHERE created_at >= $4)::text       AS week,
       COUNT(*) FILTER (WHERE created_at >= $5)::text       AS day
     FROM user_events
     WHERE user_id = $1
     GROUP BY event_type, sig_type`,
    [userId, year, month, week, day],
  );

  const result: Record<PeriodKey, PeriodStats> = {
    forever: emptyPeriod(),
    year:    emptyPeriod(),
    month:   emptyPeriod(),
    week:    emptyPeriod(),
    day:     emptyPeriod(),
  };

  for (const row of rows) {
    const counts: Record<PeriodKey, number> = {
      forever: parseInt(row.forever, 10),
      year:    parseInt(row.year,    10),
      month:   parseInt(row.month,   10),
      week:    parseInt(row.week,    10),
      day:     parseInt(row.day,     10),
    };

    if (row.event_type === 'jump') {
      for (const p of PERIODS) result[p].jumps += counts[p];
    } else if (row.event_type === 'signature') {
      const t = (row.sig_type ?? 'unknown') as SigType;
      const bucket: SigType = SIG_TYPES.includes(t) ? t : 'unknown';
      for (const p of PERIODS) {
        result[p].signatures.total += counts[p];
        result[p].signatures[bucket] += counts[p];
      }
    }
  }

  res.json(result);
});

export default router;
