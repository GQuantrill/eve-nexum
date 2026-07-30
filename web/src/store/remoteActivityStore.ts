import { create } from 'zustand';

// Tracks map-topology changes made by OTHER viewers (remote SSE events whose
// actor isn't this client) — so the voice announcer can call out "new connections
// added" without announcing the user's own edits. Ephemeral; reset on map switch.

interface RemoteActivityState {
  connectionAdds: number;   // count of remote connection.add events this session
  noteConnectionAdd: () => void;
  reset: () => void;
}

export const useRemoteActivity = create<RemoteActivityState>((set) => ({
  connectionAdds: 0,
  noteConnectionAdd: () => set((s) => ({ connectionAdds: s.connectionAdds + 1 })),
  reset: () => set({ connectionAdds: 0 }),
}));
