import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { onDesktopEvent } from '../desktop/bridge';
import { lookupSystem } from './useCharacterLocation';
import { pilotIsOffline } from './pilotActivity';
import { useShareMode } from '../context/ShareModeContext';
import { createPolledStore } from './createPolledStore';

export interface AccountCharLocation {
  charId:        number;
  characterId:   number;
  characterName: string;
  online:        boolean;        // false = position is from last known system
  eveSystemId:   number;
  systemName:    string | null;
  systemClass:   string | null;
}

export interface AccountLocations {
  /** solarSystemId → the account's characters currently shown there. */
  bySystem: Map<number, AccountCharLocation[]>;
  /** users.id → that character's location (for following a tracked character). */
  byChar:   Map<number, AccountCharLocation>;
}

interface RawResponse {
  characters: Array<{
    charId: number; characterId: number; characterName: string;
    online: boolean; eveSystemId: number; systemName: string | null; systemClass: string | null;
  }>;
}

// Matches the active character's location cadence (useCharacterLocation, 10 s)
// so a tracked alt's dot keeps up without doubling the per-session request rate.
// This poll plus location/online/fleet all share the esiLimiter, so several open
// tabs add up fast; 10 s (ESI caches location ~5 s anyway) keeps well clear.
const POLL_MS = 10_000;
// Used only when the acting pilot AND every alt are logged out, at which point
// no location on the account can change.
const OFFLINE_POLL_MS = 60_000;
const EMPTY: AccountLocations = { bySystem: new Map(), byChar: new Map() };

function indexBySystem(list: AccountCharLocation[]): Map<number, AccountCharLocation[]> {
  const idx = new Map<number, AccountCharLocation[]>();
  for (const c of list) {
    const arr = idx.get(c.eveSystemId);
    if (arr) arr.push(c);
    else idx.set(c.eveSystemId, [c]);
  }
  return idx;
}

// True when two polls describe the same characters in the same places, so we
// can keep the previous reference and skip the all-node re-render. Keyed by
// charId; compares only the fields a node actually renders.
function sameLocations(a: AccountLocations, b: AccountLocations): boolean {
  if (a.byChar.size !== b.byChar.size) return false;
  for (const [k, va] of a.byChar) {
    const vb = b.byChar.get(k);
    if (!vb
        || vb.eveSystemId   !== va.eveSystemId
        || vb.online        !== va.online
        || vb.systemName    !== va.systemName
        || vb.systemClass   !== va.systemClass
        || vb.characterName !== va.characterName) return false;
  }
  return true;
}

function fromList(list: AccountCharLocation[]): AccountLocations {
  const byChar = new Map<number, AccountCharLocation>();
  for (const c of list) byChar.set(c.charId, c);
  return { bySystem: indexBySystem(list), byChar };
}

// Gating this on the ACTING pilot alone would be wrong: an alt can be in game
// while the character you're logged in as is not, and showing where those alts
// are is exactly what this endpoint is for. So it self-regulates — backing off
// only when its own last answer said nobody on the account is online either.
let anyAltOnline = false;

const store = createPolledStore<AccountLocations>({
  pollMs: POLL_MS,
  idlePollMs: OFFLINE_POLL_MS,
  idle: () => pilotIsOffline() && !anyAltOnline,
  empty: EMPTY,
  equals: sameLocations,
  fetch: async () => {
    const list = (await api<RawResponse>('/api/character/account-locations')).characters;
    anyAltOnline = list.some((c) => c.online);
    return fromList(list);
  },
  // Account-wide (same for every tab of this session) — share it across tabs so
  // several open tabs make one poll total, not one each.
  crossTab: {
    key: 'account-locations',
    serialize: (v) => [...v.byChar.values()],
    deserialize: (j) => fromList(j as AccountCharLocation[]),
  },
});

// ── Desktop app: each alt's own Local chat log ──────────────────────────────
// The desktop app reads every logged-in character's Local log, so an alt that
// jumps moves on the map at once instead of at the next ESI poll. Same rules as
// the acting character (useCharacterLocation): only an alt ESI already has
// online, only a recent line, and only until ESI catches up. While a log move
// is fresh, ESI still answering with a system the alt has just left is stale;
// any other answer from ESI is the truth and ends the log move. Display only:
// nothing here is sent to the server or draws connections.
const LOG_TRUST_MS = 30_000;
const LOG_MAX_AGE_MS = 2 * 60_000;

interface LogMove {
  system: { eveSystemId: number; name: string; systemClass: string };
  /** Systems ESI may still report while it catches up (the ones just left). */
  stale: Set<number>;
  at: number;
}
let logMoves = new Map<number, LogMove>();         // users.id -> move
const moveSubs = new Set<() => void>();
const notifyMoves = () => moveSubs.forEach((fn) => fn());
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

interface LocalChange { characterId: number | null; characterName: string | null; system: string; at: number }

async function onAltLocal(ev: LocalChange): Promise<void> {
  if (Date.now() - ev.at > LOG_MAX_AGE_MS) return;
  const find = () => [...store.peek().byChar.values()].find((c) =>
    ev.characterId != null ? c.characterId === ev.characterId
      : ev.characterName != null && c.characterName.toLowerCase() === ev.characterName.toLowerCase());
  if (!find()?.online) return;               // ESI hasn't placed them yet: let it
  const sys = await lookupSystem(ev.system);
  const alt = find();
  if (!sys || !alt?.online) return;
  const prev = logMoves.get(alt.charId);
  const fresh = prev && Date.now() - prev.at < LOG_TRUST_MS ? prev : null;
  const shown = fresh && fresh.stale.has(alt.eveSystemId) ? fresh.system.eveSystemId : alt.eveSystemId;
  if (shown === sys.eveSystemId) return;
  const stale = new Set(fresh?.stale ?? []);
  stale.add(alt.eveSystemId);
  if (fresh) stale.add(fresh.system.eveSystemId);
  stale.delete(sys.eveSystemId);
  logMoves = new Map(logMoves).set(alt.charId, {
    system: { eveSystemId: sys.eveSystemId, name: sys.name, systemClass: sys.systemClass },
    stale,
    at: Date.now(),
  });
  notifyMoves();
  // Forget it once ESI has had its chance.
  setTimeout(() => {
    const m = logMoves.get(alt.charId);
    if (m && Date.now() - m.at >= LOG_TRUST_MS) {
      logMoves = new Map(logMoves);
      logMoves.delete(alt.charId);
      notifyMoves();
    }
  }, LOG_TRUST_MS + 100);
  // One early ESI confirmation for however many alts just jumped (the poll
  // shares the ESI budget, so never one per alt).
  if (!confirmTimer) {
    confirmTimer = setTimeout(() => { confirmTimer = null; store.refresh(); }, 4_000);
  }
}

let altLogsStarted = false;
function startAltLogs(): void {
  if (altLogsStarted) return;
  altLogsStarted = true;
  onDesktopEvent<LocalChange>('nexum://local', (ev) => { void onAltLocal(ev); });
}

// ESI's answer with the fresh log moves laid over it. Memoised on both inputs
// so every SystemNode gets the same object (and no re-render) until one changes.
let merged: { base: AccountLocations; moves: Map<number, LogMove>; out: AccountLocations } | null = null;
function withLogMoves(base: AccountLocations, moves: Map<number, LogMove>): AccountLocations {
  if (moves.size === 0) return base;
  if (merged && merged.base === base && merged.moves === moves) return merged.out;
  let changed = false;
  const list = [...base.byChar.values()].map((c) => {
    const m = moves.get(c.charId);
    if (!m || !c.online || !m.stale.has(c.eveSystemId)) return c;
    changed = true;
    return { ...c, eveSystemId: m.system.eveSystemId, systemName: m.system.name, systemClass: m.system.systemClass };
  });
  const out = changed ? fromList(list) : base;
  merged = { base, moves, out };
  return out;
}

function subscribeMoves(cb: () => void): () => void {
  moveSubs.add(cb);
  return () => { moveSubs.delete(cb); };
}
const getMoves = () => logMoves;

/**
 * The signed-in account's OTHER characters (alts) and where each is — live when
 * online, else their last known system. Shared module cache so every SystemNode
 * consumes a single poll. Empty in share mode (no session). In the desktop app,
 * an alt's jump shows at once from its own Local log (see above).
 */
export function useAccountLocations(): AccountLocations {
  const { isShareMode } = useShareMode();
  const base = store.use(!isShareMode);
  const moves = useSyncExternalStore(subscribeMoves, getMoves);
  useEffect(() => { if (!isShareMode) startAltLogs(); }, [isShareMode]);
  return isShareMode ? base : withLogMoves(base, moves);
}
