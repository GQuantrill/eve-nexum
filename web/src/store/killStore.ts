import { create } from 'zustand';

// Live "a kill just happened here" flags — ephemeral, fed by the SSE stream
// (server-side zKillboard consumer). Kept out of mapStore because it isn't map
// data and is reset on every map switch. Mirrors presenceStore's per-system
// index so each SystemNode subscribes to just its own system and re-renders only
// when a kill lands there.

// How long a kill keeps a system flagged before the badge fades. The client
// can't read the server's KILL_FEED_RECENT_SECONDS, so this is the display
// window; nodes also gate on it via the shared 30s ticker.
export const RECENT_KILL_MS = 15 * 60 * 1000;

export interface KillFlag {
  killmailId: number;
  shipTypeId: number;
  totalValue: number;
  atMs:       number;
}

interface KillState {
  // Latest kill per eveSystemId.
  bySystem: Map<number, KillFlag>;
  recordKill: (k: { eveSystemId: number } & KillFlag) => void;
  reset: () => void;
}

export const useKillStore = create<KillState>((set) => ({
  bySystem: new Map(),
  recordKill: ({ eveSystemId, ...kill }) => set((s) => {
    const next = new Map(s.bySystem);
    // Opportunistically drop flags that have already aged out so the map can't
    // grow unbounded on a busy feed.
    const cutoff = Date.now() - RECENT_KILL_MS;
    for (const [sysId, k] of next) if (k.atMs < cutoff) next.delete(sysId);
    // Keep only the most recent kill for a system.
    const existing = next.get(eveSystemId);
    if (!existing || kill.atMs >= existing.atMs) next.set(eveSystemId, kill);
    return { bySystem: next };
  }),
  reset: () => set({ bySystem: new Map() }),
}));

// Per-system selector — mirrors the presence-store slice so a node only
// re-renders when its own system's flag changes.
export function useSystemKill(eveSystemId: number | null | undefined): KillFlag | undefined {
  return useKillStore((s) => (eveSystemId == null ? undefined : s.bySystem.get(eveSystemId)));
}
