import { create } from 'zustand';

// Active jump-range overlay: the chosen staging system + the systems within range
// of it (keyed by EVE system id) so nodes on the map can highlight themselves.
// Populated by useJumpRange after it fetches; consumed by SystemNode. Cleared
// when the overlay is turned off (staging = null).

export interface InRangeInfo {
  ly:        number;   // distance from staging (light years)
  color:     string;   // colour of the widest class that can reach it
  classKeys: string[]; // class keys that can reach it (widest first)
}

interface JumpRangeState {
  stagingId:   number | null;               // EVE system id of the staging system
  stagingName: string | null;
  inRange:     Map<number, InRangeInfo>;     // eveSystemId -> reach info
  filterClass: string | null;               // active ship-class filter (null = all)
  setStaging:  (id: number | null, name?: string | null) => void;
  setInRange:  (m: Map<number, InRangeInfo>) => void;
  setFilterClass: (key: string | null) => void;
}

export const useJumpRangeStore = create<JumpRangeState>((set) => ({
  stagingId:   null,
  stagingName: null,
  inRange:     new Map(),
  filterClass: null,
  setStaging:  (id, name = null) => set({ stagingId: id, stagingName: name, inRange: new Map(), filterClass: null }),
  setInRange:  (m) => set({ inRange: m }),
  setFilterClass: (key) => set({ filterClass: key }),
}));
