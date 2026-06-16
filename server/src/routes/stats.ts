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

const DAILY_DAYS = 30;

router.get('/', async (req, res) => {
  const userId = req.session.userId;
  // optionalAuth means a share-token viewer can reach here with no session —
  // they have nothing to attribute, so return empty stats rather than running
  // the queries with a NULL user id.
  if (!userId) {
    const empty: Record<PeriodKey, PeriodStats> = {
      forever: emptyPeriod(), year: emptyPeriod(), month: emptyPeriod(),
      week: emptyPeriod(), day: emptyPeriod(),
    };
    return res.json({ ...empty, daily: Array(DAILY_DAYS).fill(0) });
  }

  const now   = new Date();
  const day   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week  = new Date(now.getTime() - 7   * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000);
  const year  = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const bucketParams = [userId, year, month, week, day];

  // Daily series window — go back DAILY_DAYS-1 days at UTC midnight so today
  // sits in the right-most slot regardless of the current hour.
  const dailySince = new Date(now);
  dailySince.setUTCHours(0, 0, 0, 0);
  dailySince.setUTCDate(dailySince.getUTCDate() - (DAILY_DAYS - 1));

  // Three parallel queries. Both jumps and sigs read the append-only
  // user_events log (event_type 'jump' / 'signature'), so the figures are a
  // record of ACTIVITY — how much you scanned/jumped in the window — and are
  // immune to later deletions or overwrite-paste removals. (Earlier the sig
  // counts came from the live map_signatures table, which undercounted: a
  // heavy scan yesterday that was since re-scanned/cleared vanished, so "this
  // week" could read the same as "last 24h".) The sig_type recorded is the
  // type at scan time; rows logged before the sig_type column carry NULL and
  // bucket as 'unknown'.
  //   daily — per-day scan count for the last DAILY_DAYS days (sparkline)
  const [jumpRes, sigRes, dailyRes] = await Promise.all([
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
       FROM user_events
       WHERE user_id = $1 AND event_type = 'signature'
       GROUP BY sig_type`,
      bucketParams,
    ),
    db.query<{ bucket: string; count: string }>(
      `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date::text AS bucket,
              COUNT(*)::text                                                AS count
         FROM user_events
        WHERE user_id = $1 AND event_type = 'signature'
          AND created_at >= $2
        GROUP BY bucket`,
      [userId, dailySince],
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

  // Build a dense DAILY_DAYS-long array, oldest first, today last.
  const byBucket = new Map<string, number>();
  for (const row of dailyRes.rows) byBucket.set(row.bucket, parseInt(row.count, 10));
  const daily: number[] = [];
  for (let i = 0; i < DAILY_DAYS; i++) {
    const d = new Date(dailySince);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    daily.push(byBucket.get(key) ?? 0);
  }

  res.json({ ...result, daily });
});

export default router;
