import { create } from 'zustand';

// Live kill flags + a chronological kill log — ephemeral, fed by the SSE stream
// (server-side zKillboard consumer) and, on panel open, a REST backfill. Kept
// out of mapStore because it isn't map data and is reset on every map switch.
// `bySystem` mirrors presenceStore's per-system index so each SystemNode
// subscribes to just its own system and re-renders only when a kill lands there.

// How long a kill keeps a system flagged before the badge fades. The client
// can't read the server's KILL_FEED_RECENT_SECONDS, so this is the display
// window; nodes also gate on it via the shared 30s ticker.
export const RECENT_KILL_MS = 15 * 60 * 1000;

// Newest-first log cap — plenty for the panel, bounded so a busy feed can't grow
// the array without limit.
const LOG_CAP = 300;

// A single decorated kill — the exact shape the server sends on the `kill.recent`
// SSE event and returns from GET /api/maps/:id/kills/backfill. Every display name
// is resolved server-side from a numeric id (no zKill string is forwarded).
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

// A per-system flag carries the kill plus when WE received it. The node badge
// freshness is gated on `flaggedAtMs` (receipt), NOT the killmail's `atMs`:
// zKill/ESI often deliver a killmail 15+ min after the kill, so gating on the
// kill time would leave a live kill already "stale" on arrival and it would
// never flash. Receipt time makes every live kill flash for the full window.
export type KillFlag = KillRow & { flaggedAtMs: number };

interface KillState {
  // Latest kill per eveSystemId — drives the pulsing node badge.
  bySystem: Map<number, KillFlag>;
  // Chronological feed (newest first, deduped by killmailId) — drives the panel.
  log: KillRow[];
  // A single live kill: flag its system AND prepend to the log.
  recordKill: (row: KillRow) => void;
  // Seed the log from the REST backfill without re-pulsing nodes.
  seedBackfill: (rows: KillRow[]) => void;
  reset: () => void;
}

function prependDeduped(log: KillRow[], row: KillRow): KillRow[] {
  if (log.some((k) => k.killmailId === row.killmailId)) return log;
  return [row, ...log].slice(0, LOG_CAP);
}

export const useKillStore = create<KillState>((set) => ({
  bySystem: new Map(),
  log: [],
  recordKill: (row) => set((s) => {
    const now = Date.now();
    const next = new Map(s.bySystem);
    // Opportunistically drop flags that have aged out (by receipt time) so the
    // map can't grow unbounded on a busy feed.
    const cutoff = now - RECENT_KILL_MS;
    for (const [sysId, k] of next) if (k.flaggedAtMs < cutoff) next.delete(sysId);
    // Keep the most recent kill for a system; stamp receipt time so the badge
    // flashes for the full window regardless of the killmail's (possibly stale)
    // timestamp.
    const existing = next.get(row.eveSystemId);
    if (!existing || row.atMs >= existing.atMs) next.set(row.eveSystemId, { ...row, flaggedAtMs: now });
    return { bySystem: next, log: prependDeduped(s.log, row) };
  }),
  seedBackfill: (rows) => set((s) => {
    // Merge backfilled history into the log (deduped), newest first, capped.
    // Does NOT touch bySystem — old kills shouldn't re-pulse nodes.
    const byId = new Map<number, KillRow>();
    for (const r of [...s.log, ...rows]) byId.set(r.killmailId, r);
    const log = [...byId.values()].sort((a, b) => b.atMs - a.atMs).slice(0, LOG_CAP);
    return { log };
  }),
  reset: () => set({ bySystem: new Map(), log: [] }),
}));

// Per-system selector — mirrors the presence-store slice so a node only
// re-renders when its own system's flag changes.
export function useSystemKill(eveSystemId: number | null | undefined): KillFlag | undefined {
  return useKillStore((s) => (eveSystemId == null ? undefined : s.bySystem.get(eveSystemId)));
}

// The chronological kill log for the panel.
export function useKillLog(): KillRow[] {
  return useKillStore((s) => s.log);
}
