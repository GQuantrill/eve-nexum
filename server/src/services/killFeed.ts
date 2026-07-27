import { config } from '../config.js';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { activeMapIds, publishToMap } from './mapEvents.js';

// Single-process consumer of zKillboard's RedisQ live feed. Long-polls the feed,
// filters to high-value kills in systems that are currently on a live map, and
// pushes a `kill.recent` event over the SSE stream so the client can flash the
// system node. Opt-in (KILL_FEED=1). zKill fair-use: one consumer, a reachable
// User-Agent contact, and backoff on failure — never a tight retry loop.
const log = createLogger('killFeed');

// ttw = long-poll wait (seconds): RedisQ holds the request open until a kill
// arrives or the window elapses, so an idle feed paces itself with no client-side
// delay and no busy-poll.
const REDISQ_URL = `https://redisq.zkillboard.com/listen.php?queueID=${encodeURIComponent(config.killFeed.queueId)}&ttw=10`;
const USER_AGENT = `Eve-Nexum/1.0 (${config.killFeed.contact})`;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const MIN_CYCLE_MS = 2_000;
const SEEN_CAP = 2000;

// RedisQ payload — untrusted external input. Every field is coerced with Number()
// at the use site; we forward only numeric ids + value + timestamp to clients,
// never any attacker/victim name strings.
interface RedisQResponse {
  package: {
    killmail?: {
      killmail_id?:     number;
      killmail_time?:   string;
      solar_system_id?: number;
      victim?:          { ship_type_id?: number };
    };
    zkb?: { totalValue?: number };
  } | null;
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

async function pollOnce(): Promise<void> {
  const res = await fetch(REDISQ_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`RedisQ HTTP ${res.status}`);

  const body = await res.json() as RedisQResponse;
  const km = body?.package?.killmail;
  if (!km) return; // idle window — nothing this cycle

  const killmailId    = Number(km.killmail_id);
  const solarSystemId = Number(km.solar_system_id);
  if (!Number.isFinite(killmailId) || !Number.isFinite(solarSystemId)) return;
  if (!markSeen(killmailId)) return;

  const totalValue = Number(body!.package!.zkb?.totalValue ?? 0);
  if (!(totalValue >= config.killFeed.minValueIsk)) return;

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

  const shipTypeId = Number(km.victim?.ship_type_id) || 0;
  const parsed = km.killmail_time ? Date.parse(km.killmail_time) : NaN;
  const atMs = Number.isFinite(parsed) ? parsed : Date.now();

  for (const { mapId } of rows) {
    publishToMap(mapId, {
      type:        'kill.recent',
      actor:       null,
      eveSystemId: solarSystemId,
      killmailId,
      shipTypeId,
      totalValue,
      atMs,
    });
  }
}

let running = false;

async function loop(): Promise<void> {
  let backoff = 1_000;
  while (running) {
    const started = Date.now();
    try {
      await pollOnce();
      backoff = 1_000; // success resets backoff (RedisQ ttw already paces us)
      // Floor the request rate. RedisQ's ttw=10 normally holds the request ~10s,
      // but if it ever returns fast (proxy, empty burst) this keeps us from
      // busy-polling the feed — fair-use insurance, negligible for real kills.
      const elapsed = Date.now() - started;
      if (elapsed < MIN_CYCLE_MS) await sleep(MIN_CYCLE_MS - elapsed);
    } catch (err) {
      log.warn(`RedisQ poll failed (retry in ${Math.round(backoff / 1000)}s):`, err instanceof Error ? err.message : err);
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
  log.info(`live kill feed enabled (queueId="${config.killFeed.queueId}", min ${config.killFeed.minValueIsk.toLocaleString()} ISK)`);
  void loop();
}
