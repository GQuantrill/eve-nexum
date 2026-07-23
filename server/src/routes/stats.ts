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

// Granularity of the activity chart per period. The chart follows the selected
// period: last-24h is hourly, a week/month are daily, a year and all-time are
// monthly. Every bucket reads the same append-only user_events log, so any
// granularity is just a date_trunc away — no extra tables.
type BucketUnit = 'hour' | 'day' | 'month';
interface SeriesSpec { unit: BucketUnit; since: Date; count: number }

// Longest all-time monthly series we'll render — bounds the array for an
// account with years of history (the app itself is far younger, so in practice
// "forever" is a handful of months).
const MAX_FOREVER_MONTHS = 120;

function truncUTC(d: Date, unit: BucketUnit): Date {
  const x = new Date(d);
  x.setUTCMilliseconds(0); x.setUTCSeconds(0); x.setUTCMinutes(0);
  if (unit === 'day' || unit === 'month') x.setUTCHours(0);
  if (unit === 'month') x.setUTCDate(1);
  return x;
}
function addUnit(d: Date, unit: BucketUnit, i: number): Date {
  const x = new Date(d);
  if (unit === 'hour')     x.setUTCHours(x.getUTCHours() + i);
  else if (unit === 'day') x.setUTCDate(x.getUTCDate() + i);
  else                     x.setUTCMonth(x.getUTCMonth() + i);
  return x;
}
// Canonical bucket key matching the SQL to_char below, in UTC. For day/month
// buckets the truncated hour is 00, so one format string covers all three.
function bucketKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}`;
}
function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

// The window + granularity for each period, ending at the current bucket.
function seriesSpecs(now: Date, firstEvent: Date): Record<PeriodKey, SeriesSpec> {
  const hour  = truncUTC(now, 'hour');
  const day   = truncUTC(now, 'day');
  const month = truncUTC(now, 'month');
  const foreverCount = Math.min(MAX_FOREVER_MONTHS, monthsBetween(truncUTC(firstEvent, 'month'), month) + 1);
  return {
    day:     { unit: 'hour',  since: addUnit(hour,  'hour',  -23), count: 24 },
    week:    { unit: 'day',   since: addUnit(day,   'day',    -6), count: 7  },
    month:   { unit: 'day',   since: addUnit(day,   'day',   -29), count: 30 },
    year:    { unit: 'month', since: addUnit(month, 'month', -11), count: 12 },
    // Clamp the start forward if history exceeds the cap, so it still ends at
    // the current month.
    forever: { unit: 'month', since: addUnit(month, 'month', -(Math.max(1, foreverCount) - 1)), count: Math.max(1, foreverCount) },
  };
}

// Dense per-bucket signature counts for one period, oldest first, current
// bucket last. Missing buckets fill 0.
async function bucketSeries(userId: number, spec: SeriesSpec): Promise<number[]> {
  const { rows } = await db.query<{ bucket: string; count: string }>(
    `SELECT to_char(date_trunc($2, created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24') AS bucket,
            COUNT(*)::text AS count
       FROM user_events
      WHERE user_id = $1 AND event_type = 'signature' AND created_at >= $3
      GROUP BY bucket`,
    [userId, spec.unit, spec.since],
  );
  const byBucket = new Map<string, number>();
  for (const r of rows) byBucket.set(r.bucket, parseInt(r.count, 10));
  const out: number[] = [];
  for (let i = 0; i < spec.count; i++) out.push(byBucket.get(bucketKey(addUnit(spec.since, spec.unit, i))) ?? 0);
  return out;
}

interface Series { unit: BucketUnit; values: number[] }
function emptySeries(): Record<PeriodKey, Series> {
  const specs = seriesSpecs(new Date(), new Date());
  const out = {} as Record<PeriodKey, Series>;
  for (const p of PERIODS) out[p] = { unit: specs[p].unit, values: Array(specs[p].count).fill(0) };
  return out;
}

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
    return res.json({ ...empty, series: emptySeries() });
  }

  const now   = new Date();
  const day   = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week  = new Date(now.getTime() - 7   * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000);
  const year  = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const bucketParams = [userId, year, month, week, day];

  // Both jumps and sigs read the append-only user_events log (event_type
  // 'jump' / 'signature'), so the figures are a record of ACTIVITY — how much
  // you scanned/jumped in the window — and are immune to later deletions or
  // overwrite-paste removals. (Earlier the sig counts came from the live
  // map_signatures table, which undercounted: a heavy scan yesterday that was
  // since re-scanned/cleared vanished, so "this week" could read the same as
  // "last 24h".) The sig_type recorded is the type at scan time; rows logged
  // before the sig_type column carry NULL and bucket as 'unknown'.
  //   min — first signature event, so "all time" knows how many months to span.
  const [jumpRes, sigRes, minRes] = await Promise.all([
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
    db.query<{ min: string | null }>(
      `SELECT MIN(created_at)::text AS min
         FROM user_events
        WHERE user_id = $1 AND event_type = 'signature'`,
      [userId],
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

  // One activity series per period, at the period's own granularity, so the
  // chart follows the selected range instead of always showing 30 days.
  const firstEvent = minRes.rows[0]?.min ? new Date(minRes.rows[0].min) : now;
  const specs = seriesSpecs(now, firstEvent);
  const seriesValues = await Promise.all(PERIODS.map((p) => bucketSeries(userId, specs[p])));
  const series = {} as Record<PeriodKey, Series>;
  PERIODS.forEach((p, i) => { series[p] = { unit: specs[p].unit, values: seriesValues[i] }; });

  res.json({ ...result, series });
});

export default router;
