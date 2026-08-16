import { config } from '../config.js';

// A single high-value kill recorded from the live R2Z2 feed, held in memory so
// the kill-log backfill can be served WITHOUT any zKillboard REST calls. Numeric
// ids only (untrusted-safe); display names are resolved on read via buildKillRow.
export interface BufferedKill {
  killmailId:            number;
  atMs:                  number;
  eveSystemId:           number;
  shipTypeId:            number;
  totalValue:            number;
  victimCharacterId:     number | null;
  victimCorporationId:   number | null;
  finalBlowCharacterId:  number | null;
  finalBlowCorporationId: number | null;
  finalBlowShipTypeId:   number;
  npc:                   boolean;
}

// Rolling in-memory buffer of recent kills, fed by the live consumer. Append
// order ~= time order (the feed is chronological). Bounded by BOTH age and a
// hard MAX_ENTRIES so it can't grow without limit on a busy feed.
const MAX_ENTRIES = 20_000;
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

// Recent kills in the given systems, newest-first, capped to `limit`.
export function recentKillsForSystems(systemIds: Set<number>, limit: number): BufferedKill[] {
  const cutoff = Date.now() - retentionMs;
  return buffer
    .filter((k) => k.atMs >= cutoff && systemIds.has(k.eveSystemId))
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, limit);
}

// ── Wormhole kill heat counter ──────────────────────────────────────────────
// Per-system rolling tally of EVERY wormhole kill — unlike `buffer` above, which
// is value-filtered for the kill log, this counts them all so the activity
// heatmap can light up J-space. CCP's ESI system_kills aggregate excludes
// wormhole systems entirely, so this is the only source of per-system WH kill
// intensity. Tracked only for wormhole systems (the caller gates on the J-space
// id range); each kill is one tick, split ship vs pod to mirror ESI's metrics.
interface KillTick { atMs: number; pod: boolean; }
const whTicks = new Map<number, KillTick[]>();
const whRetentionMs = Math.max(60_000, config.killFeed.heatWindowSeconds * 1_000);

export function recordWormholeKill(eveSystemId: number, atMs: number, pod: boolean): void {
  let ticks = whTicks.get(eveSystemId);
  if (!ticks) { ticks = []; whTicks.set(eveSystemId, ticks); }
  ticks.push({ atMs, pod });
  const cutoff = Date.now() - whRetentionMs;
  while (ticks.length && ticks[0].atMs < cutoff) ticks.shift();
  if (ticks.length === 0) whTicks.delete(eveSystemId);
}

export interface WhKillCount { shipKills: number; podKills: number; }

// Per-system wormhole kill counts within the last `windowMs`, split into ship
// vs pod losses (matching ESI's ship_kills / pod_kills). Prunes fully-stale
// systems as it reads so the map can't accumulate dead entries.
export function wormholeKillCounts(windowMs: number): Map<number, WhKillCount> {
  const cutoff = Date.now() - windowMs;
  const out = new Map<number, WhKillCount>();
  for (const [sysId, ticks] of whTicks) {
    while (ticks.length && ticks[0].atMs < cutoff) ticks.shift();
    if (ticks.length === 0) { whTicks.delete(sysId); continue; }
    let ship = 0, pod = 0;
    for (const t of ticks) { if (t.atMs >= cutoff) { t.pod ? pod++ : ship++; } }
    if (ship || pod) out.set(sysId, { shipKills: ship, podKills: pod });
  }
  return out;
}
