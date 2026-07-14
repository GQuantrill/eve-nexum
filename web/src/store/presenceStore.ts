import { create } from 'zustand';

// Live "who's viewing this map and where" — ephemeral, fed by the SSE stream.
// Kept out of mapStore because it isn't map data and is reset on every switch.
export interface PresenceViewer {
  characterId:   number;
  characterName: string;
  eveSystemId:   number | null;
  shipTypeId?:   number | null;
}

interface PresenceState {
  // Source of truth, keyed by characterId.
  viewers: Record<number, PresenceViewer>;
  // Derived index: eveSystemId -> viewers currently there. Maintained
  // incrementally so a single viewer moving only swaps the two affected
  // systems' arrays; every other system keeps its exact array reference. That
  // lets each SystemNode subscribe to just `bySystem.get(mySystemId)` and skip
  // re-rendering when a viewer moves somewhere else on the map.
  bySystem: Map<number, PresenceViewer[]>;
  snapshot: (list: PresenceViewer[]) => void;
  upsert:   (v: PresenceViewer) => void;
  remove:   (characterId: number) => void;
  reset:    () => void;
}

// Rebuild the whole index from the viewer map (snapshot / reset paths).
function indexBySystem(viewers: Record<number, PresenceViewer>): Map<number, PresenceViewer[]> {
  const idx = new Map<number, PresenceViewer[]>();
  for (const v of Object.values(viewers)) {
    if (v.eveSystemId == null) continue;
    const arr = idx.get(v.eveSystemId);
    if (arr) arr.push(v);
    else idx.set(v.eveSystemId, [v]);
  }
  return idx;
}

// Apply one character's change (move / ship swap / removal) to the index while
// preserving array references for every untouched system. `next` undefined = a
// removal. Only the (at most two) systems the character left/joined get a fresh
// array; all others are shared straight through the shallow Map copy.
function withViewer(
  bySystem: Map<number, PresenceViewer[]>,
  prev: PresenceViewer | undefined,
  next: PresenceViewer | undefined,
  characterId: number,
): Map<number, PresenceViewer[]> {
  const out = new Map(bySystem);
  const touched = new Set<number>();
  if (prev?.eveSystemId != null) touched.add(prev.eveSystemId);
  if (next?.eveSystemId != null) touched.add(next.eveSystemId);
  for (const sysId of touched) {
    const arr = (bySystem.get(sysId) ?? []).filter((x) => x.characterId !== characterId);
    if (next?.eveSystemId === sysId) arr.push(next);
    if (arr.length) out.set(sysId, arr);
    else out.delete(sysId);
  }
  return out;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  viewers: {},
  bySystem: new Map(),
  snapshot: (list) => {
    const viewers: Record<number, PresenceViewer> = Object.fromEntries(list.map((v) => [v.characterId, v]));
    set({ viewers, bySystem: indexBySystem(viewers) });
  },
  upsert: (v) => set((s) => ({
    viewers:  { ...s.viewers, [v.characterId]: v },
    bySystem: withViewer(s.bySystem, s.viewers[v.characterId], v, v.characterId),
  })),
  remove: (characterId) => set((s) => {
    const prev = s.viewers[characterId];
    if (!prev) return s;
    const next = { ...s.viewers };
    delete next[characterId];
    return { viewers: next, bySystem: withViewer(s.bySystem, prev, undefined, characterId) };
  }),
  reset: () => set({ viewers: {}, bySystem: new Map() }),
}));
