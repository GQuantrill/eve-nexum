import { api } from '../api/client';
import { createPolledStore } from './createPolledStore';

export interface SystemKills {
  systemId:  number;
  shipKills: number;
  podKills:  number;
  npcKills:  number;
  jumps:     number;
}

const POLL_MS = 5 * 60 * 1000;
const EMPTY = new Map<number, SystemKills>();

// True when two fetches hold identical kill counts, so we keep the previous Map
// reference and skip the all-node re-render. The 5-min poll is a reconciliation
// backstop (it also catches kills aging out of the live window, which fire no
// event); most polls are no-ops, and live kills refresh via refreshCurrentKills.
function sameKills(a: Map<number, SystemKills>, b: Map<number, SystemKills>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb
        || vb.shipKills !== va.shipKills
        || vb.podKills  !== va.podKills
        || vb.npcKills  !== va.npcKills
        || vb.jumps     !== va.jumps) return false;
  }
  return true;
}

const store = createPolledStore<Map<number, SystemKills>>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: sameKills,
  fetch: async () => {
    const rows = await api<SystemKills[]>('/api/activity/current-kills');
    return new Map(rows.map((r) => [r.systemId, r]));
  },
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Trigger a refetch from the live kill feed (called on each `kill.recent` SSE),
// so the heatmap updates within ~a second of a kill instead of waiting for the
// 5-min poll. Debounced: a burst of kills coalesces into ONE refetch, and the
// server holds the authoritative windowed count so this can't drift (unlike an
// optimistic bump). store.refresh() no-ops when nothing is displaying the heatmap.
export function refreshCurrentKills(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    store.refresh();
  }, 1500);
}

export function useCurrentHourKills(): Map<number, SystemKills> {
  return store.use();
}
