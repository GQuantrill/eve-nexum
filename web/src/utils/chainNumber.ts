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

/**
 * After a jump from one map system to another: ask the server to number the
 * arrival, when the map numbers chains and the link is a wormhole.
 */
export function requestChainNumber(mapId: string, fromId: string, toId: string, connId: string): void {
  const { map } = useMapStore.getState();
  if (!map.chainNumbering || map.id !== mapId) return;
  const to = map.systems.find((s) => s.id === toId);
  if (!to || to.isHome || to.chainLabel) return;
  const p = (async () => {
    try {
      const ct = await (awaitConnectionType(connId)
        ?? Promise.resolve(useMapStore.getState().map.connections.find((c) => c.id === connId)?.connectionType ?? 'standard'));
      if (ct !== 'standard') return null;
      const r = await api<{ chainLabel: string | null }>(`/api/maps/${mapId}/systems/${toId}/chain-number`, {
        method: 'POST', body: JSON.stringify({ fromSystemId: fromId }),
      });
      if (r.chainLabel && useMapStore.getState().map.id === mapId) {
        useMapStore.setState((s) => ({
          map: { ...s.map, systems: s.map.systems.map((x) => (x.id === toId ? { ...x, chainLabel: r.chainLabel } : x)) },
        }));
      }
      return r.chainLabel;
    } catch {
      return null; // best-effort: a missed number can be set by hand
    } finally {
      pending.delete(toId);
    }
  })();
  pending.set(toId, p);
}

/** Wait (briefly) for a number being asked for, then answer the system's number. */
export async function chainNumberSettled(systemId: string, timeoutMs = 4000): Promise<void> {
  const p = pending.get(systemId);
  if (!p) return;
  await Promise.race([p, new Promise((r) => setTimeout(r, timeoutMs))]);
}
