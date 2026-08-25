import { create } from 'zustand';

// Active jump-range overlay: the chosen staging system + the systems within range
// of it (keyed by EVE system id) so nodes on the map can highlight themselves.
// Populated by useJumpRange (mounted globally in MapCanvas, so the overlay works
// whether or not the Jump Range pane is open); consumed by SystemNode. Cleared
// when the overlay is turned off (staging = null).

export interface InRangeInfo {
  ly:        number;   // distance from staging (light years)
  color:     string;   // colour of the widest class that can reach it
  classKeys: string[]; // class keys that can reach it (widest first)
}

// A LS/NS system within jump range of the staging system, scoped to the current
// map. Also the row shape the Jump Range pane lists.
export interface JumpTarget {
  eveSystemId: number;
  name:        string;
  systemClass: string;      // 'LS' | 'NS'
  security:    number;
  regionName:  string | null;
  ly:          number;
}

interface JumpRangeState {
  stagingId:   number | null;               // EVE system id of the staging system
  stagingName: string | null;
  inRange:     Map<number, InRangeInfo>;     // eveSystemId -> reach info
  filterClass: string | null;               // active ship-class filter (null = all)
  // Pane-facing result, kept in the store (not the pane) so the fetch runs once,
  // globally — the overlay lights up from the context-menu action without the
  // pane being open.
  targets:     JumpTarget[];
  loading:     boolean;
  hasCoords:   boolean;
  setStaging:  (id: number | null, name?: string | null) => void;
  setInRange:  (m: Map<number, InRangeInfo>) => void;
  setFilterClass: (key: string | null) => void;
  setResult:   (r: { targets: JumpTarget[]; loading: boolean; hasCoords: boolean }) => void;
}

export const useJumpRangeStore = create<JumpRangeState>((set) => ({
  stagingId:   null,
  stagingName: null,
  inRange:     new Map(),
  filterClass: null,
  targets:     [],
  loading:     false,
  hasCoords:   true,
  setStaging:  (id, name = null) => set({ stagingId: id, stagingName: name, inRange: new Map(), filterClass: null, targets: [], hasCoords: true }),
  setInRange:  (m) => set({ inRange: m }),
  setFilterClass: (key) => set({ filterClass: key }),
  setResult:   (r) => set({ targets: r.targets, loading: r.loading, hasCoords: r.hasCoords }),
}));
