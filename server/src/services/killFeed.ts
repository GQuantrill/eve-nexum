import { config } from '../config.js';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { activeMapIds, publishToMap } from './mapEvents.js';
import { resolveEntityNames } from './entityNames.js';
import { notifyDiscord, killEmbed } from './discord.js';

// A single decorated kill, shared by the live SSE `kill.recent` event and the
// REST backfill (routes/maps.ts). Every display name is resolved by US from a
// numeric id (resolveEntityNames + SDE) — no zKill-supplied string is ever
// forwarded (ESI killmails carry only ids anyway).
export interface KillRow {
  killmailId:          number;
  atMs:                number;
  eveSystemId:         number;
  systemName:          string;
  regionName:          string | null;
  shipTypeId:          number;
  shipTypeName:        string;
  totalValue:          number;
  victimCharacterId:   number | null;
  victimName:          string | null;
  victimCorporationId: number | null;
  victimCorpName:      string | null;
}

// Static SDE lookups, cached in-process (system/region and ship-type names never
// change between SDE re-seeds). Shared by the live consumer and the backfill.
const systemMetaCache = new Map<number, { systemName: string; regionName: string | null }>();
export async function resolveSystemMeta(id: number): Promise<{ systemName: string; regionName: string | null }> {
  const hit = systemMetaCache.get(id);
  if (hit) return hit;
  const { rows } = await db.query<{ systemName: string; regionName: string | null }>(
    `SELECT s.name AS "systemName", r.name AS "regionName"
       FROM solar_systems s
       LEFT JOIN map_regions r ON r.id = s.region_id
      WHERE s.id = $1`,
    [id],
  );
  const meta = rows[0] ?? { systemName: String(id), regionName: null };
  systemMetaCache.set(id, meta);
  return meta;
}

const shipNameCache = new Map<number, string>();
export async function resolveShipTypeName(id: number): Promise<string> {
  if (!id) return '';
  const hit = shipNameCache.get(id);
  if (hit !== undefined) return hit;
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM item_types WHERE id = $1`, [id]);
  const name = rows[0]?.name ?? '';
  shipNameCache.set(id, name);
  return name;
}

// Single-process consumer of zKillboard's live killmail feed. Filters to
// high-value kills in systems that are currently on a live map and pushes a
// `kill.recent` event over the SSE stream so the client can flash the system
// node. Opt-in (KILL_FEED=1).
//
// Transport is zKill's R2Z2 "ephemeral" feed (the replacement for the
// sunset-2026 RedisQ): fetch a starting sequence, then GET each
// /ephemeral/{seq}.json in order, incrementing until a 404 (caught up), then
// sleep >= 6s and resume. Fair-use: one consumer, a reachable User-Agent
// contact (a blank UA is Cloudflare-blocked), stay under 15 req/s, and honour
// the mandatory 6s idle wait (violating it earns a 403). See
// https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)
const log = createLogger('killFeed');

const R2Z2_SEQUENCE_URL = 'https://r2z2.zkillboard.com/ephemeral/sequence.json';
const r2z2KillUrl = (seq: number) => `https://r2z2.zkillboard.com/ephemeral/${seq}.json`;
const USER_AGENT = `Eve-Nexum/1.0 (${config.killFeed.contact})`; // non-blank UA required (Cloudflare)
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const IDLE_SLEEP_MS = 6_000;  // mandatory >=6s wait after a 404 (caught up) — a shorter wait is 403'd
const REQ_SPACING_MS = 120;   // ~8 req/s while catching up; comfortably under the 15 req/s cap
const SEEN_CAP = 2000;

// R2Z2 ephemeral payload — untrusted external input. Every field is coerced with
// Number() at the use site. ESI killmails carry only ids (no names); the display
// names we send to clients are resolved by US from those ids (resolveEntityNames
// + SDE), so no zKill-supplied string is ever forwarded.
interface EsiKillmail {
  killmail_id?:     number;
  killmail_time?:   string;
  solar_system_id?: number;
  victim?:          { ship_type_id?: number; character_id?: number; corporation_id?: number };
}
interface EphemeralKill {
  killmail_id?: number;
  esi?:         EsiKillmail;       // the raw ESI killmail (R2Z2 nests it under `esi`)
  zkb?:         { totalValue?: number };
}

// Bounded FIFO of recently-seen killmail ids — drops repeats across reconnects
// without growing unbounded (insertion order lets us evict the oldest).
const seen = new Set<number>();
function markSeen(id: number): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// GET a JSON document. A 404 is a normal signal (no killmail at this sequence
// yet), returned as status 404 with a null body rather than thrown.
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`R2Z2 HTTP ${res.status}`);
  return { status: 200, body: await res.json() };
}

// Process one ephemeral killmail: filter, match to live maps, decorate, publish.
async function processKill(body: EphemeralKill): Promise<void> {
  const km = body.esi ?? {};
  const killmailId    = Number(body.killmail_id ?? km.killmail_id);
  const solarSystemId = Number(km.solar_system_id);
  if (!Number.isFinite(killmailId) || !Number.isFinite(solarSystemId)) return;
  if (!markSeen(killmailId)) return;
  stats.seen++;

  const totalValue = Number(body.zkb?.totalValue ?? 0);
  if (!(totalValue >= config.killFeed.minValueIsk)) return;
  stats.overMin++;

  // Only touch the DB when at least one map is actually being watched.
  const live = activeMapIds();
  if (!live.length) return;

  const { rows } = await db.query<{ mapId: string }>(
    `SELECT DISTINCT map_id AS "mapId"
       FROM map_systems
      WHERE eve_system_id = $1 AND map_id = ANY($2::uuid[])`,
    [solarSystemId, live],
  );
  if (!rows.length) return;

  // Numeric ids only from the (untrusted) killmail. character_id is absent for
  // structure/NPC-only losses -> null. `Number(x) || null` maps 0/NaN to null;
  // a real id is a large positive number so it survives.
  const shipTypeId          = Number(km.victim?.ship_type_id) || 0;
  const victimCharacterId   = Number(km.victim?.character_id) || null;
  const victimCorporationId = Number(km.victim?.corporation_id) || null;
  const parsed = km.killmail_time ? Date.parse(km.killmail_time) : NaN;
  const atMs = Number.isFinite(parsed) ? parsed : Date.now();

  // Resolve who/what/where from the ids on OUR side (ESI cache + SDE) — the
  // killmail carries no names, so nothing untrusted is echoed to clients.
  const [meta, shipTypeName, names] = await Promise.all([
    resolveSystemMeta(solarSystemId),
    resolveShipTypeName(shipTypeId),
    resolveEntityNames([victimCharacterId, victimCorporationId]),
  ]);
  const killRow: KillRow = {
    killmailId, atMs, eveSystemId: solarSystemId,
    systemName: meta.systemName, regionName: meta.regionName,
    shipTypeId, shipTypeName, totalValue,
    victimCharacterId,
    victimName: victimCharacterId ? names.get(victimCharacterId)?.name ?? null : null,
    victimCorporationId,
    victimCorpName: victimCorporationId ? names.get(victimCorporationId)?.name ?? null : null,
  };

  for (const { mapId } of rows) {
    publishToMap(mapId, { type: 'kill.recent', actor: null, ...killRow });
  }
  stats.forwarded++;
  log.info(`forwarded kill in ${meta.systemName} (${Math.round(totalValue / 1e6)}M ISK) -> ${rows.length} map(s)`);

  // Corp/alliance Discord kill alert for the matched maps (opt-in per org).
  await dispatchDiscord(rows.map((r) => r.mapId), killRow);
}

// Send a Discord kill alert to the webhook of each matched corp/alliance map
// that has one configured and whose per-org min-ISK the kill clears. Dedupes by
// URL so two maps sharing a webhook get a single message. Best-effort — a webhook
// lookup failure is logged and swallowed, never breaking the poll loop.
async function dispatchDiscord(mapIds: string[], kill: KillRow): Promise<void> {
  if (!mapIds.length) return;
  try {
    const { rows } = await db.query<{ killWebhook: string | null; killMinIsk: string }>(
      `SELECT COALESCE(cds.kill_webhook, ads.kill_webhook)      AS "killWebhook",
              COALESCE(cds.kill_min_isk, ads.kill_min_isk, 0)   AS "killMinIsk"
         FROM maps m
         LEFT JOIN corp_discord_settings     cds ON cds.corp_id     = m.corp_id
         LEFT JOIN alliance_discord_settings ads ON ads.alliance_id = m.alliance_id
        WHERE m.id = ANY($1::uuid[])`,
      [mapIds],
    );
    const sent = new Set<string>();
    for (const r of rows) {
      if (!r.killWebhook || sent.has(r.killWebhook)) continue;
      if (kill.totalValue < Number(r.killMinIsk)) continue;
      sent.add(r.killWebhook);
      notifyDiscord(r.killWebhook, killEmbed(kill));
    }
  } catch (err) {
    log.warn('kill Discord dispatch failed:', err instanceof Error ? err.message : err);
  }
}

let running = false;

// Rolling counters for the heartbeat log, so "is the feed actually working?" is
// observable: `seen` = killmails pulled from the firehose, `overMin` = those at
// or above the ISK floor, `forwarded` = those in a currently-viewed map's
// systems (the ones that flash a node). seen climbing with forwarded stuck at 0
// just means no big kill has happened in a mapped system yet — not a fault.
const stats = { seen: 0, overMin: 0, forwarded: 0 };
const HEARTBEAT_MS = 120_000;

async function loop(): Promise<void> {
  let backoff = 1_000;
  let seq: number | null = null;
  while (running) {
    try {
      // Obtain a starting sequence once (and again after a hard error resets it).
      if (seq === null) {
        const { body } = await getJson(R2Z2_SEQUENCE_URL);
        const n = Number((body as { sequence?: number } | null)?.sequence);
        if (!Number.isFinite(n)) throw new Error('R2Z2 sequence.json: missing sequence');
        seq = n;
      }
      const { status, body } = await getJson(r2z2KillUrl(seq));
      if (status === 404) {
        // Caught up — no killmail at this sequence yet. Honour the mandatory
        // >=6s wait, then retry the SAME sequence.
        await sleep(IDLE_SLEEP_MS);
        backoff = 1_000;
        continue;
      }
      await processKill(body as EphemeralKill);
      seq += 1;                     // advance past the processed killmail
      backoff = 1_000;
      await sleep(REQ_SPACING_MS);  // pace catch-up bursts under the 15 req/s cap
    } catch (err) {
      log.warn(`R2Z2 poll failed (retry in ${Math.round(backoff / 1000)}s):`, err instanceof Error ? err.message : err);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

// Start the live kill feed. No-op unless KILL_FEED is set. Follows the
// startXxx() + feature-flag-gate pattern of the other background services.
export function startKillFeed(): void {
  if (!config.killFeed.enabled) {
    log.info('live kill feed disabled (KILL_FEED unset)');
    return;
  }
  if (running) return;
  running = true;
  log.info(`live kill feed enabled (R2Z2 ephemeral, min ${config.killFeed.minValueIsk.toLocaleString()} ISK)`);
  const hb = setInterval(() => {
    log.info(`heartbeat: ${stats.seen} seen, ${stats.overMin} >= min ISK, ${stats.forwarded} forwarded to live maps`);
  }, HEARTBEAT_MS);
  hb.unref?.();
  void loop();
}
