import { create } from 'zustand';

// The scope groups a login can ask for. Mirrors server utils/esiScopes.ts
// SCOPE_GROUP_IDS; the server decides which a deployment offers and which are
// optional (GET /auth/scope-options).
export const SCOPE_GROUP_IDS = [
  'location', 'ship', 'waypoints', 'standings', 'orgStandings', 'citadels', 'fleet', 'clones', 'director',
] as const;
export type ScopeGroupId = typeof SCOPE_GROUP_IDS[number];

// What the picker is open for: a first login, adding a character, or changing
// what an existing character allows (optionally pointing at the group a feature
// just found missing).
export type ScopePickerTarget =
  // ticked: the groups to start with (a returning character's last choice);
  // omitted = everything.
  | { kind: 'login'; ticked?: readonly string[] }
  | { kind: 'add' }
  // charId is the account character (users.id); omitted = the signed-in one.
  | { kind: 'change'; charId?: number; require?: ScopeGroupId };

interface ScopePickerState {
  target: ScopePickerTarget | null;
  open:   (target: ScopePickerTarget) => void;
  close:  () => void;
}

// A store so the landing page, the character menu and any "Needs X. Enable"
// prompt can all open the one picker mounted at the app root.
export const useScopePickerStore = create<ScopePickerState>((set) => ({
  target: null,
  open:   (target) => set({ target }),
  close:  () => set({ target: null }),
}));
