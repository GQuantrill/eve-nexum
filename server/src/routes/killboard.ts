import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/cache.js';
import { resolveEntityNames } from '../services/entityNames.js';
import { esiFetch } from '../utils/esi.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('killboard');

const ZKB_AGENT    = 'Eve-Nexum/1.0 (https://github.com/GQuantrill/eve-nexum; gq@area404.org)';
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

interface ZkbEntry {
  killmail_id: number;
  zkb: {
    hash:       string;
    totalValue: number;
    solo:       boolean;
    npc:        boolean;
  };
}

interface EsiKillmail {
  killmail_id:   number;
  killmail_time: string;
  victim: {
    character_id?:   number;
    corporation_id?: number;
    alliance_id?:    number;
    ship_type_id:    number;
  };
  attackers: Array<{
    character_id?:   number;
    corporation_id?: number;
    alliance_id?:    number;
    ship_type_id?:   number;
    final_blow:      boolean;
  }>;
}

export interface KillEntry {
  killmail_id:   number;
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
  zkb: ZkbEntry['zkb'];
}

// Per-system kill cache. The shared TtlCache utility handles TTL + the
// background sweep that used to live inline here.
const cache = new TtlCache<string, KillEntry[]>(CACHE_TTL_MS, 15 * 60 * 1000);

// Separate, long-lived cache for the "last kill" lookup (the /:id/last route).
// A quiet system's most-recent kill barely changes, so a 30-minute TTL keeps
// the extra zKill/ESI calls to a trickle even for systems in constant view.
// Value is the ISO killmail time, or null = no kills on record for the system.
const LAST_KILL_TTL_MS = 30 * 60 * 1000;
const lastKillCache = new TtlCache<string, string | null>(LAST_KILL_TTL_MS, 60 * 60 * 1000);

// Cap parallel ESI killmail fetches and share in-flight promises across
// concurrent callers so two clients hitting the same system don't double the
// load on ESI.
const ESI_MAX_CONCURRENT = 6;
let esiActive = 0;
const esiQueue: Array<() => void> = [];
const esiInflight = new Map<string, Promise<EsiKillmail | null>>();

function acquireSlot(): Promise<void> {
  if (esiActive < ESI_MAX_CONCURRENT) { esiActive++; return Promise.resolve(); }
  return new Promise<void>((resolve) => { esiQueue.push(() => { esiActive++; resolve(); }); });
}

function releaseSlot() {
  esiActive--;
  const next = esiQueue.shift();
  if (next) next();
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function fetchEsi(killmailId: number, hash: string): Promise<EsiKillmail | null> {
  const key = `${killmailId}/${hash}`;
  const existing = esiInflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<EsiKillmail | null> => {
    await acquireSlot();
    try {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/killmails/${killmailId}/${hash}/`,
        { signal: withTimeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      return (await res.json()) as EsiKillmail;
    } catch {
      return null;
    } finally {
      releaseSlot();
      esiInflight.delete(key);
    }
  })();

  esiInflight.set(key, promise);
  return promise;
}

// Fetch (and cache) every kill in a system over the past `pastSeconds`, hydrated
// from ESI and decorated with resolved char/corp/alliance names. Shared by the
// killboard route (24h) and the kill-log backfill (1h). SSRF-safe: the URL is
// built from the bounded NUMBER, never raw text. Cache is keyed by
// system:pastSeconds so the two windows don't clobber each other.
export async function fetchSystemKills(
  systemId: number,
  pastSeconds: number,
  opts: { minValueIsk?: number; maxKills?: number } = {},
): Promise<KillEntry[]> {
  if (!Number.isInteger(systemId) || systemId <= 0 || systemId > 100_000_000) return [];
  const secs = Number.isInteger(pastSeconds) && pastSeconds > 0 && pastSeconds <= 604_800 ? pastSeconds : 86_400;
  const minValueIsk = Math.max(0, opts.minValueIsk ?? 0);
  const maxKills = opts.maxKills && opts.maxKills > 0 ? opts.maxKills : 0; // 0 = no cap
  // Cache per (system, window, value-floor, cap) — the filtered result differs,
  // so the killboard pane (no floor/cap) and the kill-log backfill don't collide.
  const key = `${systemId}:${secs}:${minValueIsk}:${maxKills}`;

  const fresh = cache.get(key);
  if (fresh) return fresh.value;
  const stale = cache.peek(key);

  const zkbUrl = `https://zkillboard.com/api/kills/solarSystemID/${systemId}/pastSeconds/${secs}/`;
  const zkbHeaders: Record<string, string> = { 'User-Agent': ZKB_AGENT, Accept: 'application/json' };
  const cachedEtag = typeof stale?.meta?.etag === 'string' ? stale.meta.etag : undefined;
  if (cachedEtag) zkbHeaders['If-None-Match'] = cachedEtag;

  try {
    const zkbRes = await fetch(zkbUrl, { headers: zkbHeaders, signal: withTimeout(FETCH_TIMEOUT_MS) });

    // Nothing changed — refresh the TTL on the existing entry and return it.
    if (zkbRes.status === 304 && stale) {
      cache.set(key, stale.value, stale.meta);
      return stale.value;
    }
    if (!zkbRes.ok) {
      if (stale) return stale.value;
      log.warn(`zKillboard returned ${zkbRes.status} for system ${systemId}`);
      return [];
    }

    const zkbBody = (await zkbRes.json()) as ZkbEntry[];
    if (!Array.isArray(zkbBody)) {
      if (stale) return stale.value;
      log.warn(`Unexpected response from zKillboard for system ${systemId}`);
      return [];
    }

    const etag = zkbRes.headers.get('etag') ?? undefined;

    // Filter by value and cap to the newest N BEFORE hydrating. The zKill list
    // already carries zkb.totalValue, and killmail_id is monotonic with time, so
    // we only pay an ESI call for kills we actually keep. Without this a busy
    // region (e.g. The Forge) hydrates thousands of cheap kills per open, trips
    // ESI/zKill rate limits, and falls back to stale data — dropping the newest
    // kills, differently each run. Defaults (floor 0, no cap) = pane unchanged.
    let wanted = minValueIsk > 0
      ? zkbBody.filter((k) => (k.zkb?.totalValue ?? 0) >= minValueIsk)
      : zkbBody;
    if (maxKills > 0 && wanted.length > maxKills) {
      wanted = [...wanted].sort((a, b) => b.killmail_id - a.killmail_id).slice(0, maxKills);
    }

    // Hydrate full killmails from ESI in parallel (capped at ESI_MAX_CONCURRENT
    // so a busy system queues rather than thundering CCP).
    const esiResults = await Promise.all(wanted.map((k) => fetchEsi(k.killmail_id, k.zkb.hash)));

    const kills = wanted
      .map((zkb, i) => {
        const esi = esiResults[i];
        if (!esi) return null;
        const entry: KillEntry = {
          killmail_id:   esi.killmail_id,
          killmail_time: esi.killmail_time,
          victim:        esi.victim,
          // Only store what we render to keep the cache lean
          attackers: esi.attackers.map((a) => ({
            character_id:   a.character_id,
            corporation_id: a.corporation_id,
            alliance_id:    a.alliance_id,
            ship_type_id:   a.ship_type_id,
            final_blow:     a.final_blow,
          })),
          zkb: zkb.zkb,
        };
        return entry;
      })
      .filter((k): k is KillEntry => k !== null);

    // Resolve every char/corp/alliance ID in one batch and decorate in place.
    const nameIds: number[] = [];
    for (const k of kills) {
      nameIds.push(k.victim.character_id!, k.victim.corporation_id!, k.victim.alliance_id!);
      for (const a of k.attackers) {
        nameIds.push(a.character_id!, a.corporation_id!, a.alliance_id!);
      }
    }
    const names = await resolveEntityNames(nameIds);
    for (const k of kills) {
      if (k.victim.character_id)   k.victim.character_name   = names.get(k.victim.character_id)?.name;
      if (k.victim.corporation_id) k.victim.corporation_name = names.get(k.victim.corporation_id)?.name;
      if (k.victim.alliance_id)    k.victim.alliance_name    = names.get(k.victim.alliance_id)?.name;
      for (const a of k.attackers) {
        if (a.character_id)   a.character_name   = names.get(a.character_id)?.name;
        if (a.corporation_id) a.corporation_name = names.get(a.corporation_id)?.name;
        if (a.alliance_id)    a.alliance_name    = names.get(a.alliance_id)?.name;
      }
    }

    cache.set(key, kills, etag ? { etag } : undefined);
    return kills;
  } catch (err) {
    log.warn(`Failed to reach zKillboard for system ${systemId}:`, (err as Error).message);
    if (stale) return stale.value;
    return [];
  }
}

router.get('/:systemId(\\d+)', async (req, res) => {
  // The route pattern already constrains this to digits, but parse to a bounded
  // integer so no attacker-controlled text can ever reach the outbound request.
  const idNum = Number(req.params.systemId);
  if (!Number.isInteger(idNum) || idNum <= 0 || idNum > 100_000_000) {
    return res.status(400).json({ error: 'Invalid system id' });
  }
  return res.json(await fetchSystemKills(idNum, 86_400));
});

// GET /:systemId/last — the timestamp of the most recent kill in the system,
// of ANY age (unlike the 24h list above). Returns { killmailTime: string|null }
// where null means zKillboard has no kills on record for the system. Only the
// client's empty-24h state needs this, so it's fetched lazily and cached for a
// long time here to keep zKill happy.
router.get('/:systemId(\\d+)/last', async (req, res) => {
  const idNum = Number(req.params.systemId);
  if (!Number.isInteger(idNum) || idNum <= 0 || idNum > 100_000_000) {
    return res.status(400).json({ error: 'Invalid system id' });
  }
  const systemId = String(idNum);

  const fresh = lastKillCache.get(systemId);
  if (fresh) return res.json({ killmailTime: fresh.value });
  const stale = lastKillCache.peek(systemId);

  // No pastSeconds → zKillboard returns the system's most recent kills, newest
  // first. We only need the first entry's time.
  const zkbUrl = `https://zkillboard.com/api/kills/solarSystemID/${idNum}/`;
  const zkbHeaders: Record<string, string> = {
    'User-Agent': ZKB_AGENT,
    Accept:       'application/json',
  };
  const cachedEtag = typeof stale?.meta?.etag === 'string' ? stale.meta.etag : undefined;
  if (cachedEtag) zkbHeaders['If-None-Match'] = cachedEtag;

  try {
    const zkbRes = await fetch(zkbUrl, { headers: zkbHeaders, signal: withTimeout(FETCH_TIMEOUT_MS) });

    if (zkbRes.status === 304 && stale) {
      lastKillCache.set(systemId, stale.value, stale.meta);
      return res.json({ killmailTime: stale.value });
    }
    if (!zkbRes.ok) {
      if (stale) return res.json({ killmailTime: stale.value });
      log.warn(`zKillboard (last) returned ${zkbRes.status} for system ${systemId}`);
      return res.json({ killmailTime: null });
    }

    const body = (await zkbRes.json()) as ZkbEntry[];
    const etag = zkbRes.headers.get('etag') ?? undefined;

    if (!Array.isArray(body) || body.length === 0) {
      // Genuinely nothing on record — cache the null so we don't re-ask soon.
      lastKillCache.set(systemId, null, etag ? { etag } : undefined);
      return res.json({ killmailTime: null });
    }

    const newest = body[0];
    const esi = await fetchEsi(newest.killmail_id, newest.zkb.hash);
    const time = esi?.killmail_time ?? null;
    // Only cache a resolved time; if ESI failed, fall back to stale and don't
    // poison the cache with a transient null.
    if (time !== null) lastKillCache.set(systemId, time, etag ? { etag } : undefined);
    else if (stale) return res.json({ killmailTime: stale.value });
    return res.json({ killmailTime: time });
  } catch (err) {
    log.warn(`Failed to reach zKillboard (last) for system ${systemId}:`, (err as Error).message);
    if (stale) return res.json({ killmailTime: stale.value });
    return res.json({ killmailTime: null });
  }
});

export default router;
