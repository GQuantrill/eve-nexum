import { config } from '../config.js';

// A single high-value kill recorded from the live R2Z2 feed, held in memory so
// the kill-log backfill can be served WITHOUT any zKillboard REST calls. Numeric
// ids only (untrusted-safe); display names are resolved on read via buildKillRow.
export interface BufferedKill {
  killmailId:          number;
  atMs:                number;
  eveSystemId:         number;
  shipTypeId:          number;
  totalValue:          number;
  victimCharacterId:   number | null;
  victimCorporationId: number | null;
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
