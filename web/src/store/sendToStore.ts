import { create } from 'zustand';

// Which system the "Send to characters…" picker is open for, if any. A store
// rather than local state so the map's right-click menu and the system panel
// can both open the one picker MapCanvas mounts.
interface SendToState {
  target: { eveSystemId: number; name: string } | null;
  open:   (eveSystemId: number, name: string) => void;
  close:  () => void;
}

export const useSendToStore = create<SendToState>((set) => ({
  target: null,
  open:   (eveSystemId, name) => set({ target: { eveSystemId, name } }),
  close:  () => set({ target: null }),
}));
