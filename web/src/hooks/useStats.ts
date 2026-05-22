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

export type StatsResponse = Record<StatPeriod, PeriodStats> & {
  /** Sig counts per day for the last 30 days, oldest first, today last. */
  daily: number[];
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
