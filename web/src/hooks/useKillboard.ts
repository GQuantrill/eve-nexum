import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';

export type KillTag = 'gate' | 'hic' | 'dic' | 'sb' | 'solo' | 'ganked' | 'awox' | 'padding' | 'npc';
export type KillWindow = '1h' | '24h' | '7d';
export const KILL_WINDOWS: KillWindow[] = ['1h', '24h', '7d'];

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
  /** gate / hic / dic / sb / solo / npc, worked out by the server. */
  tags?: KillTag[];
  /** Whole-map lists: which system the kill was in. */
  eveSystemId?: number;
  systemName?: string;
}

interface CacheEntry {
  kills: ZkbKill[];
  total: number | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
// Cache the *raw* (unfiltered) response so toggling NPC inclusion doesn't
// require a refetch — we just re-apply the filter. Keyed by what was asked for
// (system or map, and the window).
const clientCache = new Map<string, CacheEntry>();

export interface UseKillboardOptions {
  /** Include NPC-only kills (zkb.npc === true). Defaults to false. */
  includeNpc?: boolean;
  window?: KillWindow;
  /** Set to list every system on this map instead of the one system. */
  mapId?: string | null;
}

export function useKillboard(eveSystemId: number | null, options: UseKillboardOptions = {}) {
  const { includeNpc = false, window = '24h', mapId = null } = options;
  // What to load, as a cache key and URL; null = nothing to show.
  const source = useMemo(() => {
    if (mapId) return { key: `map:${mapId}:${window}`, url: `/api/maps/${mapId}/kills?window=${window}`, map: true };
    if (eveSystemId) return { key: `sys:${eveSystemId}:${window}`, url: `/api/killboard/${eveSystemId}?window=${window}`, map: false };
    return null;
  }, [eveSystemId, mapId, window]);

  // Raw (unfiltered) data goes through state so toggling `includeNpc`
  // doesn't require a refetch — we re-apply the filter in a useMemo below.
  const [rawKills, setRawKills]     = useState<ZkbKill[]>([]);
  const [total, setTotal]           = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const cancelledRef = useRef(false);
  const sourceRef    = useRef<typeof source>(null);

  // Stable fetcher exposed via the hook return so consumers (e.g. the
  // killboard pane's NPC toggle) can force-refresh on demand. `force=true`
  // skips the TTL cache check; otherwise the cache is honoured.
  const refresh = useCallback(async (force = false) => {
    const src = sourceRef.current;
    if (!src) return;
    const cached = clientCache.get(src.key);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setRawKills(cached.kills);
      setTotal(cached.total);
      setLastUpdated(new Date(cached.fetchedAt));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body = await api<ZkbKill[] | { kills: ZkbKill[]; total: number }>(src.url);
      if (cancelledRef.current || sourceRef.current?.key !== src.key) return;
      const kills = Array.isArray(body) ? body : body.kills;
      const tot = Array.isArray(body) ? null : body.total;
      clientCache.set(src.key, { kills, total: tot, fetchedAt: Date.now() });
      setRawKills(kills);
      setTotal(tot);
      setLastUpdated(new Date());
    } catch {
      if (!cancelledRef.current) setError('Could not load kill data');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    sourceRef.current = source;
    if (!source) {
      // Deliberate: clears this pane's own state when the record it shows changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRawKills([]);
      setTotal(null);
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
  }, [source, refresh]);

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
  return { kills, total, loading, error, lastUpdated, npcCount, refresh, isMap: !!source?.map };
}

interface LastKillCacheEntry { time: string | null; at: number }
const lastKillClientCache = new Map<number, LastKillCacheEntry>();
const LAST_KILL_CACHE_TTL_MS = 30 * 60 * 1000;

// The system's most recent kill of ANY age (server /last endpoint), for when
// the 24h list is empty. Only fetched when `enabled` — the killboard pane turns
// it on solely for quiet systems, so active systems never pay for it. Returns:
//   undefined = not loaded yet / disabled
//   null      = no kills on record for the system
//   string    = ISO time of the last kill
export function useLastKill(eveSystemId: number | null, enabled: boolean) {
  const [lastKillTime, setLastKillTime] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    // Deliberate: clears this pane's own state when the record it shows changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!eveSystemId || !enabled) { setLastKillTime(undefined); return; }

    const cached = lastKillClientCache.get(eveSystemId);
    if (cached && Date.now() - cached.at < LAST_KILL_CACHE_TTL_MS) {
      setLastKillTime(cached.time);
      return;
    }

    let cancelled = false;
    api<{ killmailTime: string | null }>(`/api/killboard/${eveSystemId}/last`)
      .then((d) => {
        if (cancelled) return;
        lastKillClientCache.set(eveSystemId, { time: d.killmailTime, at: Date.now() });
        setLastKillTime(d.killmailTime);
      })
      .catch(() => { if (!cancelled) setLastKillTime(undefined); });

    return () => { cancelled = true; };
  }, [eveSystemId, enabled]);

  return lastKillTime;
}
