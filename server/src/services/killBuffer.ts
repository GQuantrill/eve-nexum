import { config } from '../config.js';

// A kill recorded from the live R2Z2 feed -- every kill, whatever it's worth --
// held in memory so the kill-log backfill (which applies the ISK floor) and the
// killboard pane (which doesn't) can be served without waiting on zKillboard's
// REST API, which zKill caches for up to an hour. Numeric
// ids only (untrusted-safe); display names are resolved on read via buildKillRow.
export interface BufferedKill {
  killmailId:            number;
  atMs:                  number;
  eveSystemId:           number;
  shipTypeId:            number;
  totalValue:            number;
  victimCharacterId:     number | null;
  victimCorporationId:   number | null;
  victimAllianceId?:     number | null;
  finalBlowCharacterId:  number | null;
  finalBlowCorporationId: number | null;
  finalBlowAllianceId?:  number | null;
  finalBlowShipTypeId:   number;
  /** How many attackers the killmail lists (the killboard shows "+N"). */
  attackerCount?:        number;
  solo?:                 boolean;
  npc:                   boolean;
}

// Rolling in-memory buffer of recent kills, fed by the live consumer. Append
// order ~= time order (the feed is chronological). Bounded by BOTH age and a
// hard MAX_ENTRIES so it can't grow without limit on a busy feed: New Eden
// sees roughly 1,000-2,000 kills an hour, so the default 3h window sits far
// below the cap.
const MAX_ENTRIES = 30_000;
const retentionMs = Math.max(60_000, config.killFeed.backfillSeconds * 1_000);

const buffer: BufferedKill[] = [];
const seen = new Set<number>();

// Record a kill (deduped by killmailId), then prune the front: entries older
// than the retention window, plus any overflow past MAX_ENTRIES. Front-pruning
// is valid because the feed delivers in ~time order; recentKillsForSystems also
// age-filters, so an out-of-order straggler is excluded from results regardless.
export function recordKill(k: BufferedKill): void {
  if (seen.has(k.killmailId)) return;
  seen.add(k.killmailId);
  buffer.push(k);
  const cutoff = Date.now() - retentionMs;
  while (buffer.length && (buffer[0].atMs < cutoff || buffer.length > MAX_ENTRIES)) {
    const dropped = buffer.shift()!;
    seen.delete(dropped.killmailId);
  }
}

// Recent kills in the given systems worth at least `minValueIsk`, newest-first,
// capped to `limit`.
export function recentKillsForSystems(systemIds: Set<number>, limit: number, minValueIsk = 0): BufferedKill[] {
  const cutoff = Date.now() - retentionMs;
  return buffer
    .filter((k) => k.atMs >= cutoff && systemIds.has(k.eveSystemId) && k.totalValue >= minValueIsk)
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, limit);
}

// ── Live kill heat counter ──────────────────────────────────────────────────
// Per-system rolling tally of EVERY kill, cluster-wide — unlike `buffer` above,
// which is value-filtered for the kill log, this counts them all so the activity
// heatmap can run off the live feed. The activity route prefers this live count
// over CCP's hourly ESI snapshot per system (it overrides, never sums), giving a
// near-real-time heatmap that also covers wormhole space — which ESI's
// system_kills aggregate omits entirely. Each kill is one tick, bucketed to
// mirror ESI: npc (killed by NPCs) / pod (capsule victim) / ship (everything
// else).
export type KillBucket = 'ship' | 'pod' | 'npc';
interface KillTick { atMs: number; bucket: KillBucket; }
const liveTicks = new Map<number, KillTick[]>();
const liveRetentionMs = Math.max(60_000, config.killFeed.heatWindowSeconds * 1_000);

export function recordLiveKill(eveSystemId: number, atMs: number, bucket: KillBucket): void {
  let ticks = liveTicks.get(eveSystemId);
  if (!ticks) { ticks = []; liveTicks.set(eveSystemId, ticks); }
  ticks.push({ atMs, bucket });
  const cutoff = Date.now() - liveRetentionMs;
  while (ticks.length && ticks[0].atMs < cutoff) ticks.shift();
  if (ticks.length === 0) liveTicks.delete(eveSystemId);
}

export interface LiveKillCount { shipKills: number; podKills: number; npcKills: number; }

// Per-system kill counts within the last `windowMs`, split into ship / pod / npc
// losses (matching ESI's ship_kills / pod_kills / npc_kills). Prunes fully-stale
// systems as it reads so the map can't accumulate dead entries.
export function liveKillCounts(windowMs: number): Map<number, LiveKillCount> {
  const cutoff = Date.now() - windowMs;
  const out = new Map<number, LiveKillCount>();
  for (const [sysId, ticks] of liveTicks) {
    while (ticks.length && ticks[0].atMs < cutoff) ticks.shift();
    if (ticks.length === 0) { liveTicks.delete(sysId); continue; }
    let ship = 0, pod = 0, npc = 0;
    for (const t of ticks) {
      if (t.atMs < cutoff) continue;
      if (t.bucket === 'npc') npc++; else if (t.bucket === 'pod') pod++; else ship++;
    }
    if (ship || pod || npc) out.set(sysId, { shipKills: ship, podKills: pod, npcKills: npc });
  }
  return out;
}
