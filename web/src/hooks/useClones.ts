import { api } from '../api/client';
import { createPolledStore } from './createPolledStore';

export interface CloneSystem {
  eveSystemId: number;
  name:        string | null;
  systemClass: string | null;
  regionName:  string | null;
}
export interface JumpClone {
  id:       number;
  name:     string | null;
  implants: number;
  system:   CloneSystem | null;
}
export interface Clones {
  /** False when this deployment hasn't opted into the clones scope, so no token
   *  has it and there is nothing to read. Distinct from "granted but empty". */
  enabled:           boolean;
  lastCloneJumpDate: string | null;
  home:              CloneSystem | null;
  jumpClones:        JumpClone[];
}

const EMPTY: Clones = { enabled: false, lastCloneJumpDate: null, home: null, jumpClones: [] };

// Clones move only when a pilot deliberately moves them, and ESI caches the
// endpoint for ~2 minutes, so this is a slow poll — it exists to be CURRENT
// enough for the clone-jump check, not live. Cross-tab de-duplicated like the
// other account-wide polls.
const POLL_MS = 5 * 60 * 1000;

function same(a: Clones, b: Clones): boolean {
  if (a.enabled !== b.enabled) return false;
  if (a.lastCloneJumpDate !== b.lastCloneJumpDate) return false;
  if ((a.home?.eveSystemId ?? null) !== (b.home?.eveSystemId ?? null)) return false;
  if (a.jumpClones.length !== b.jumpClones.length) return false;
  return a.jumpClones.every((c, i) =>
    c.id === b.jumpClones[i].id
    && (c.system?.eveSystemId ?? null) === (b.jumpClones[i].system?.eveSystemId ?? null));
}

const store = createPolledStore<Clones>({
  pollMs: POLL_MS,
  empty: EMPTY,
  equals: same,
  // A 403 means the session predates the clones scope. Treated as "no data"
  // rather than an error: the pane says so, and the clone-jump check simply
  // falls back to not suppressing anything.
  fetch: () => api<Clones>('/api/character/clones').catch(() => EMPTY),
  crossTab: {
    key: 'clones',
    serialize: (v) => v,
    deserialize: (j) => (j && typeof j === 'object' ? j as Clones : EMPTY),
  },
});

export function useClones(): Clones {
  return store.use();
}

/** Every system this character has a clone in — medical and jump. */
export function cloneSystemIds(c: Clones): Set<number> {
  const ids = new Set<number>();
  if (c.home?.eveSystemId != null) ids.add(c.home.eveSystemId);
  for (const jc of c.jumpClones) if (jc.system?.eveSystemId != null) ids.add(jc.system.eveSystemId);
  return ids;
}
