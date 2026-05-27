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
  viewers: Record<number, PresenceViewer>; // keyed by characterId
  snapshot: (list: PresenceViewer[]) => void;
  upsert:   (v: PresenceViewer) => void;
  remove:   (characterId: number) => void;
  reset:    () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  viewers: {},
  snapshot: (list) => set({ viewers: Object.fromEntries(list.map((v) => [v.characterId, v])) }),
  upsert:   (v) => set((s) => ({ viewers: { ...s.viewers, [v.characterId]: v } })),
  remove:   (characterId) => set((s) => {
    if (!(characterId in s.viewers)) return s;
    const next = { ...s.viewers };
    delete next[characterId];
    return { viewers: next };
  }),
  reset: () => set({ viewers: {} }),
}));
