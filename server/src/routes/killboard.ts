import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/cache.js';
import { resolveEntityNames } from '../services/entityNames.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('killboard');

const ZKB_AGENT    = 'Eve-Nexum/1.0 (https://codeberg.org/GQuantrill/eve-nexum; gq@area404.org)';
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
      const res = await fetch(
        `https://esi.evetech.net/latest/killmails/${killmailId}/${hash}/`,
        { headers: { 'User-Agent': ZKB_AGENT, Accept: 'application/json' }, signal: withTimeout(FETCH_TIMEOUT_MS) },
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

router.get('/:systemId(\\d+)', async (req, res) => {
  const { systemId } = req.params;

  // Fresh cache hit — return immediately. peek() falls back to any stale entry
  // we can still serve from when the upstream is unhappy.
  const fresh = cache.get(systemId);
  if (fresh) return res.json(fresh.value);
  const stale = cache.peek(systemId);

  // zKillboard: every kill in the past 24h, NPC flag intact on each row.
  // We used to pass `npc/0/` to exclude NPCs at the API level, but that
  // made the client-side toggle ineffective — the server now hands back
  // everything and the killboard pane decides whether to render NPC kills
  // based on the user's preference.
  const zkbUrl = `https://zkillboard.com/api/kills/solarSystemID/${systemId}/pastSeconds/86400/`;
  const zkbHeaders: Record<string, string> = {
    'User-Agent': ZKB_AGENT,
    Accept:       'application/json',
  };
  const cachedEtag = typeof stale?.meta?.etag === 'string' ? stale.meta.etag : undefined;
  if (cachedEtag) zkbHeaders['If-None-Match'] = cachedEtag;

  try {
    const zkbRes = await fetch(zkbUrl, { headers: zkbHeaders, signal: withTimeout(FETCH_TIMEOUT_MS) });

    // zKillboard says nothing changed — refresh the TTL on the existing entry
    // and return it.
    if (zkbRes.status === 304 && stale) {
      cache.set(systemId, stale.value, stale.meta);
      return res.json(stale.value);
    }

    if (!zkbRes.ok) {
      if (stale) return res.json(stale.value);
      log.warn(`zKillboard returned ${zkbRes.status} for system ${systemId}`);
      return res.json([]);
    }

    const zkbBody = (await zkbRes.json()) as ZkbEntry[];

    if (!Array.isArray(zkbBody)) {
      if (stale) return res.json(stale.value);
      log.warn(`Unexpected response from zKillboard for system ${systemId}`);
      return res.json([]);
    }

    const etag = zkbRes.headers.get('etag') ?? undefined;

    // Fetch full killmail details from ESI in parallel. ESI concurrency is
    // capped at ESI_MAX_CONCURRENT so a busy system (Jita, active null)
    // queues rather than thundering CCP.
    const esiResults = await Promise.all(
      zkbBody.map((k) => fetchEsi(k.killmail_id, k.zkb.hash)),
    );

    const kills = zkbBody
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

    // Resolve every char/corp/alliance ID in one batch and decorate the
    // entries in-place with human names. Cache hits stay zero-cost; misses
    // pay one bounded ESI call per unique missing entity, ever.
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

    cache.set(systemId, kills, etag ? { etag } : undefined);
    return res.json(kills);
  } catch (err) {
    log.warn(`Failed to reach zKillboard for system ${systemId}:`, (err as Error).message);
    if (stale) return res.json(stale.value);
    return res.json([]);
  }
});

export default router;
