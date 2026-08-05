import { create } from 'zustand';

// Gate-jump distances from the route origin (the pilot's current / route-origin
// system) to each on-map k-space system, so a node can show "N jumps from X" on
// hover. Populated by useGateJumps from the existing /api/route engine; a single
// single-source BFS covers every target, so lookups here are O(1).
interface GateJumpsState {
  originId:   number | null;              // EVE system id the jumps are measured from
  originName: string | null;
  jumps:      Map<number, number>;        // eveSystemId -> gate jumps from origin
  setJumps: (jumps: Map<number, number>, originId: number | null, originName: string | null) => void;
}

export const useGateJumpsStore = create<GateJumpsState>((set) => ({
  originId: null,
  originName: null,
  jumps: new Map(),
  setJumps: (jumps, originId, originName) => set({ jumps, originId, originName }),
}));
