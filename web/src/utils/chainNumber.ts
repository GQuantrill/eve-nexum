// Chain numbers ("L+1", server: services/chainNumber.ts). When a map numbers
// its chain, each system's number is its path from home (5162 = hole 5, then
// 1, then 6, then 2), handed out by the server on the first wormhole jump in.
// A hole's bookmark starts with the number of the system it leads to, so the
// bookmarks sort into chain order in the EVE client. The way back towards
// home has no number.

import { api } from '../api/client';
import { useMapStore, awaitConnectionType } from '../store/mapStore';

/** A number a pilot may set by hand: digits, dots between parts past 9. Mirrors the server. */
export const CHAIN_LABEL_RE = /^(?=[.1-9])[1-9]*(\.[1-9][0-9]{0,2})*$/;

/** The parts of a label: one digit each until the first dot, then dot-separated. */
export function labelParts(label: string): number[] {
  const dot = label.indexOf('.');
  const head = dot === -1 ? label : label.slice(0, dot);
  const tail = dot === -1 ? [] : label.slice(dot + 1).split('.');
  return [...head.split('').map(Number), ...tail.map(Number)];
}

/**
 * The number for a hole from a system to the system it leads to: the far
 * system's number when it is one step further from home than this one, else
 * '' (the way back, a side link, or nothing numbered yet).
 */
export function forwardChainLabel(
  here: { isHome?: boolean; chainLabel?: string | null } | undefined,
  there: { chainLabel?: string | null } | undefined,
): string {
  const to = there?.chainLabel ?? '';
  if (!here || !to) return '';
  const from = here.isHome ? '' : here.chainLabel ?? null;
  if (from == null) return '';
  const a = labelParts(from), b = labelParts(to);
  if (b.length !== a.length + 1 || a.some((p, i) => p !== b[i])) return '';
  return to;
}

/** A format with {chain} in front when the map numbers chains and the format doesn't place it. */
export function withChain(format: string, on: boolean | undefined): string {
  return on && !format.includes('{chain}') ? `{chain} ${format}` : format;
}

// Numbers being asked for, by system: a bookmark copied right after the jump
// waits for its system's number rather than going out without it.
const pending = new Map<string, Promise<string | null>>();

// A jump out of a system with reserved holes isn't numbered until we know
// which signature was jumped: the server answers "deferred", and the number is
// asked for again (settle) once whJumpConfirm has matched the signature, or
// found there is none to match. Keyed by the arrival's map system id.
const settleGates = new Map<string, () => void>();

/** Which signature was jumped into `toId` is now known (or never will be):
 *  finish numbering it, if that was waiting. */
export function settleChainNumber(toId: string): void {
  settleGates.get(toId)?.();
}

/**
 * After a jump from one map system to another: ask the server to number the
 * arrival, when the map numbers chains and the link is a wormhole.
 */
export function requestChainNumber(mapId: string, fromId: string, toId: string, connId: string): void {
  const { map } = useMapStore.getState();
  if (!map.chainNumbering || map.id !== mapId) return;
  const to = map.systems.find((s) => s.id === toId);
  if (!to || to.isHome || to.chainLabel) return;
  // Made now, before whJumpConfirm runs, so an early settle isn't missed.
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  settleGates.set(toId, release);
  const ask = (settle: boolean) => api<{ chainLabel: string | null; deferred?: boolean }>(
    `/api/maps/${mapId}/systems/${toId}/chain-number`,
    { method: 'POST', body: JSON.stringify(settle ? { fromSystemId: fromId, settle: true } : { fromSystemId: fromId }) });
  const p = (async () => {
    try {
      const ct = await (awaitConnectionType(connId)
        ?? Promise.resolve(useMapStore.getState().map.connections.find((c) => c.id === connId)?.connectionType ?? 'standard'));
      if (ct !== 'standard') return null;
      let r = await ask(false);
      if (r.deferred) {
        await gate;
        r = await ask(true);
      }
      if (r.chainLabel && useMapStore.getState().map.id === mapId) setSystemLabel(toId, r.chainLabel);
      return r.chainLabel;
    } catch {
      return null; // best-effort: a missed number can be set by hand
    } finally {
      pending.delete(toId);
      if (settleGates.get(toId) === release) settleGates.delete(toId);
    }
  })();
  pending.set(toId, p);
}

function setSystemLabel(id: string, chainLabel: string): void {
  useMapStore.setState((s) => ({
    map: { ...s.map, systems: s.map.systems.map((x) => (x.id === id ? { ...x, chainLabel } : x)) },
  }));
}

/** The number for a system one step out of `here`, or null when `here` has
 *  none to number from (not home, not numbered). */
export function parentLabel(here: { isHome?: boolean; chainLabel?: string | null } | undefined): string | null {
  if (!here) return null;
  return here.isHome ? '' : here.chainLabel ?? null;
}

/** Is `label` the number of a hole straight out of `parent`? */
export function isChildLabel(parent: string, label: string): boolean {
  const a = parent === '' ? [] : labelParts(parent), b = labelParts(label);
  return b.length === a.length + 1 && a.every((p, i) => p === b[i]);
}

/** What the signature pane's bookmark button shows for a wormhole signature. */
export type SigChainState =
  | { kind: 'number'; label: string; reserved: boolean } // copy the bookmark (reserved: can be cleared)
  | { kind: 'reserve' }                                  // +1
  | { kind: 'none' };                                    // a plain copy button

export function sigChainState(
  sig: { sigType: string; chainLabel?: string | null },
  here: { isHome?: boolean; chainLabel?: string | null } | undefined,
  there: { isHome?: boolean; chainLabel?: string | null } | undefined,
  on: boolean,
): SigChainState {
  if (!on || sig.sigType !== 'wormhole') return { kind: 'none' };
  const parent = parentLabel(here);
  if (parent == null) return { kind: 'none' };
  if (there) {
    const f = forwardChainLabel(here, there);
    if (f) return { kind: 'number', label: f, reserved: false };
    if (there.isHome || there.chainLabel) return { kind: 'none' }; // the way back, or a side link
  }
  if (sig.chainLabel && isChildLabel(parent, sig.chainLabel)) {
    return { kind: 'number', label: sig.chainLabel, reserved: true };
  }
  return { kind: 'reserve' };
}

/** Number all: the holes to number, statics first, then by signature ID. */
export function numberAllOrder<T extends { id: string; sigId: string; whType: string }>(
  sigs: T[], statics: string[],
): T[] {
  const isStatic = (s: T) => statics.some((x) => x.toUpperCase() === (s.whType || '').toUpperCase());
  return [...sigs].sort((a, b) =>
    Number(isStatic(b)) - Number(isStatic(a)) || (a.sigId || '').localeCompare(b.sigId || ''));
}

/** Reserve chain numbers on these signatures, in order. Answers each one that
 *  holds a number afterwards. */
export async function reserveChainNumbers(
  mapId: string, systemId: string, sigIds: string[],
): Promise<{ id: string; chainLabel: string }[]> {
  const r = await api<{ reserved: { id: string; chainLabel: string }[] }>(
    `/api/maps/${mapId}/systems/${systemId}/chain-numbers`,
    { method: 'POST', body: JSON.stringify({ sigIds }) });
  return r.reserved;
}

/** Clear a reserved number on an unjumped hole. */
export async function clearChainReservation(mapId: string, systemId: string, sigRowId: string): Promise<void> {
  await api(`/api/maps/${mapId}/systems/${systemId}/signatures/${sigRowId}/chain-number`, { method: 'DELETE' });
}

/** Wait (briefly) for a number being asked for, then answer the system's number. */
export async function chainNumberSettled(systemId: string, timeoutMs = 4000): Promise<void> {
  const p = pending.get(systemId);
  if (!p) return;
  await Promise.race([p, new Promise((r) => setTimeout(r, timeoutMs))]);
}
