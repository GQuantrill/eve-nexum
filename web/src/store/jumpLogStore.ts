import { create } from 'zustand';

// Per-connection jump log — ephemeral intel fed by the SSE stream and, on panel
// open, a REST fetch. Kept out of mapStore because it isn't map topology and must
// never influence a connection's mass_used. Keyed by connectionId; the connection
// panel subscribes to just the selected connection's slice.

// Newest-first cap per connection — plenty for eyeballing recent mass, bounded so
// a busy hole can't grow the array without limit.
const PER_CONN_CAP = 100;

// One recorded crossing — the exact shape the server sends on `jump.logged` and
// returns from GET .../jumps. Ship fields are resolved server-side from the SDE.
export interface JumpRow {
  id:             string;
  connectionId:   string;
  direction:      'forward' | 'reverse';
  fromEveSystemId: number | null;
  toEveSystemId:   number | null;
  fromSystemName:  string | null;
  toSystemName:    string | null;
  characterId:    number | null;
  characterName:  string | null;
  shipTypeId:     number | null;
  shipTypeName:   string | null;
  shipGroup:      string | null;   // ship class, e.g. "Battleship"
  shipMass:       number | null;   // base SDE mass, kg
  jumpedAt:       number;          // epoch ms
}

interface JumpLogState {
  byConnection: Map<string, JumpRow[]>;   // newest-first per connection
  recordJump: (row: JumpRow) => void;     // one live jump (SSE)
  seed: (connectionId: string, rows: JumpRow[]) => void;  // REST fetch on open
  clearConnection: (connectionId: string) => void;        // log wiped (SSE / local)
  reset: () => void;                       // map switch
}

function prependDeduped(list: JumpRow[], row: JumpRow): JumpRow[] {
  if (list.some((j) => j.id === row.id)) return list;
  return [row, ...list].slice(0, PER_CONN_CAP);
}

export const useJumpLogStore = create<JumpLogState>((set) => ({
  byConnection: new Map(),
  recordJump: (row) => set((s) => {
    const next = new Map(s.byConnection);
    next.set(row.connectionId, prependDeduped(next.get(row.connectionId) ?? [], row));
    return { byConnection: next };
  }),
  seed: (connectionId, rows) => set((s) => {
    const next = new Map(s.byConnection);
    // Merge the fetched history with anything already streamed in, deduped by id,
    // newest-first, capped — so a jump that arrived via SSE between fetch start and
    // apply isn't dropped.
    const byId = new Map<string, JumpRow>();
    for (const r of [...(next.get(connectionId) ?? []), ...rows]) byId.set(r.id, r);
    const merged = [...byId.values()].sort((a, b) => b.jumpedAt - a.jumpedAt).slice(0, PER_CONN_CAP);
    next.set(connectionId, merged);
    return { byConnection: next };
  }),
  clearConnection: (connectionId) => set((s) => {
    if (!s.byConnection.has(connectionId)) return s;
    const next = new Map(s.byConnection);
    next.set(connectionId, []);
    return { byConnection: next };
  }),
  reset: () => set({ byConnection: new Map() }),
}));

// The jump log for one connection (newest-first). Stable [] when none.
const EMPTY: JumpRow[] = [];
export function useConnectionJumps(connectionId: string | null | undefined): JumpRow[] {
  return useJumpLogStore((s) => (connectionId == null ? EMPTY : s.byConnection.get(connectionId) ?? EMPTY));
}
