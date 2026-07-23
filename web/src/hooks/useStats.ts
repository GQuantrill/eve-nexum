import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type StatPeriod = 'forever' | 'year' | 'month' | 'week' | 'day';

export interface SigBreakdown {
  total:    number;
  data:     number;
  relic:    number;
  gas:      number;
  ore:      number;
  combat:   number;
  wormhole: number;
  unknown:  number;
}

export interface PeriodStats {
  jumps:      number;
  signatures: SigBreakdown;
}

/** Chart bucket granularity for a period's activity series. */
export type BucketUnit = 'hour' | 'day' | 'month';

export interface ActivitySeries {
  /** Bucket size: hourly (24h), daily (week/month), monthly (year/all-time). */
  unit:   BucketUnit;
  /** Sig counts per bucket, oldest first, current bucket last. */
  values: number[];
}

export type StatsResponse = Record<StatPeriod, PeriodStats> & {
  /** One activity series per period, at that period's own granularity. */
  series: Record<StatPeriod, ActivitySeries>;
};

export function useStats(open: boolean) {
  const [stats, setStats]     = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api<StatsResponse>('/api/stats')
      .then(setStats)
      .catch(() => setError('Could not load stats'))
      .finally(() => setLoading(false));
  }, [open]);

  return { stats, loading, error };
}
