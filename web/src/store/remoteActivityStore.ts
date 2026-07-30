import { create } from 'zustand';

// Tracks saved wormhole chains added by OTHER viewers (remote route.add SSE
// events whose actor isn't this client) — so the voice announcer can call out
// "new chain added" without announcing the user's own saves, and without firing
// on every individual map connection. Ephemeral; reset on map switch.

interface RemoteActivityState {
  chainAdds: number;   // count of remote route.add (saved-chain) events this session
  noteChainAdd: () => void;
  reset: () => void;
}

export const useRemoteActivity = create<RemoteActivityState>((set) => ({
  chainAdds: 0,
  noteChainAdd: () => set((s) => ({ chainAdds: s.chainAdds + 1 })),
  reset: () => set({ chainAdds: 0 }),
}));
