import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';

export interface ZkbKill {
  killmail_id: number;
  killmail_time: string;
  victim: {
    character_id?:     number;
    character_name?:   string;
    corporation_id?:   number;
    corporation_name?: string;
    alliance_id?:      number;
    alliance_name?:    string;
    ship_type_id:      number;
  };
  attackers: Array<{
    character_id?:     number;
    character_name?:   string;
    corporation_id?:   number;
    corporation_name?: string;
    alliance_id?:      number;
    alliance_name?:    string;
    ship_type_id?:     number;
    final_blow:        boolean;
  }>;
  zkb: {
    hash: string;
    totalValue: number;
    solo: boolean;
    npc: boolean;
  };
}

interface CacheEntry {
  kills: ZkbKill[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
// Cache the *raw* (unfiltered) zKillboard response so toggling NPC
// inclusion doesn't require a refetch — we just re-apply the filter.
const clientCache = new Map<number, CacheEntry>();

export interface UseKillboardOptions {
  /** Include NPC-only kills (zkb.npc === true). Defaults to false. */
  includeNpc?: boolean;
}

export function useKillboard(eveSystemId: number | null, options: UseKillboardOptions = {}) {
  const { includeNpc = false } = options;
  // Raw (unfiltered) data goes through state so toggling `includeNpc`
  // doesn't require a refetch — we re-apply the filter in a useMemo below.
  const [rawKills, setRawKills]     = useState<ZkbKill[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const cancelledRef = useRef(false);
  const systemRef    = useRef<number | null>(null);

  // Stable fetcher exposed via the hook return so consumers (e.g. the
  // killboard pane's NPC toggle) can force-refresh on demand. `force=true`
  // skips the TTL cache check; otherwise the cache is honoured.
  const refresh = useCallback(async (force = false) => {
    const id = systemRef.current;
    if (!id) return;
    const cached = clientCache.get(id);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setRawKills(cached.kills);
      setLastUpdated(new Date(cached.fetchedAt));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<ZkbKill[]>(`/api/killboard/${id}`);
      if (cancelledRef.current || systemRef.current !== id) return;
      clientCache.set(id, { kills: data, fetchedAt: Date.now() });
      setRawKills(data);
      setLastUpdated(new Date());
    } catch {
      if (!cancelledRef.current) setError('Could not load kill data');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    systemRef.current = eveSystemId;
    if (!eveSystemId) {
      setRawKills([]);
      setError(null);
      setLastUpdated(null);
      return;
    }

    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => refresh(), CACHE_TTL_MS);

    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [eveSystemId, refresh]);

  // zKillboard flags `npc: true` on killmails where every attacker was an
  // NPC (CONCORD pops, ratter rage, null NPC fleets). Strip them by
  // default — they're noise in a wormhole / ops feed. The toggle lets ops
  // opt back in when investigating something specific.
  const kills = useMemo(
    () => (includeNpc ? rawKills : rawKills.filter((k) => !k.zkb.npc)),
    [rawKills, includeNpc],
  );
  const npcCount = useMemo(
    () => rawKills.reduce((n, k) => n + (k.zkb.npc ? 1 : 0), 0),
    [rawKills],
  );

  return { kills, loading, error, lastUpdated, npcCount, refresh };
}
