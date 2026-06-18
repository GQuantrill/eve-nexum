import type { WormholeMap, MapSystem, SavedRoute, Signature } from '../types';

// A computed path through the map's own connections: the ordered system ids and
// the connection traversed between each consecutive pair (length = systems - 1).
export interface ChainPath {
  systemIds: string[];
  connectionIds: string[];
}

// Breadth-first shortest path A->B over the map's connections, ignoring broken
// (quarantined) links. Returns null when the two systems aren't connected.
// Unweighted BFS gives the fewest-hops path, which is what a chain wants.
export function buildChainPath(map: WormholeMap, fromId: string, toId: string): ChainPath | null {
  if (fromId === toId) return null;

  const adj = new Map<string, Array<{ to: string; connId: string }>>();
  const link = (a: string, b: string, connId: string) => {
    const list = adj.get(a);
    if (list) list.push({ to: b, connId });
    else adj.set(a, [{ to: b, connId }]);
  };
  for (const c of map.connections) {
    if (c.broken) continue;
    link(c.sourceId, c.targetId, c.id);
    link(c.targetId, c.sourceId, c.id);
  }

  const prev = new Map<string, { sys: string; connId: string }>();
  const visited = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toId) break;
    for (const { to, connId } of adj.get(cur) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to);
      prev.set(to, { sys: cur, connId });
      queue.push(to);
    }
  }
  if (!visited.has(toId)) return null;

  const systemIds: string[] = [];
  const connectionIds: string[] = [];
  let node = toId;
  while (node !== fromId) {
    const p = prev.get(node)!;
    systemIds.unshift(node);
    connectionIds.unshift(p.connId);
    node = p.sys;
  }
  systemIds.unshift(fromId);
  return { systemIds, connectionIds };
}

// gate = in-game stargate (warp to gate), wormhole = warp to its sig,
// jumpgate = player Ansiblex bridge (take the jump bridge).
export type ChainStepKind = 'gate' | 'wormhole' | 'jumpgate';

// One leg of a saved chain, resolved against the live map for display.
export interface ChainStep {
  index: number;            // 1-based hop number
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  kind: ChainStepKind;      // jump a gate, or warp a wormhole
  whType: string | null;    // wormhole code (connection's, else the matched sig's)
  sigId: string | null;     // the in-system sig code (ABC-123) to warp to, if linked
  broken: boolean;          // connection removed or quarantined — needs re-scouting
}

// Does a signature's "leads to" point at the given system (by name or class)?
function sigLeadsTo(sig: Signature, to: MapSystem | undefined): boolean {
  if (!to || !sig.whLeadsTo) return false;
  const t = sig.whLeadsTo.trim().toUpperCase();
  return t === to.name.toUpperCase() || t === to.systemClass.toUpperCase();
}

// Resolve a saved chain's stored step sequence against the current map into
// displayable steps. `sigsBySystem` is the wormhole/scan signatures per system
// (the from-system's are used to name the sig to warp to). A hop whose
// connection is gone or quarantined is flagged `broken` rather than silently
// re-routed, so the user knows that leg needs re-scouting.
export function buildChainSteps(
  route: SavedRoute,
  map: WormholeMap,
  sigsBySystem: Map<string, Signature[]>,
): ChainStep[] {
  const sysById  = new Map(map.systems.map((s) => [s.id, s]));
  const connById = new Map(map.connections.map((c) => [c.id, c]));
  const steps: ChainStep[] = [];

  for (let i = 0; i < route.connectionIds.length; i++) {
    const fromId = route.systemIds[i];
    const toId   = route.systemIds[i + 1];
    const conn   = connById.get(route.connectionIds[i]);

    let kind: ChainStepKind = 'wormhole';
    let whType: string | null = null;
    let sigId: string | null = null;
    let broken = true;

    if (conn) {
      kind   = conn.connectionType === 'gate' ? 'gate'
             : conn.connectionType === 'jumpgate' ? 'jumpgate'
             : 'wormhole';
      whType = conn.type ?? null;
      broken = conn.broken;
      if (!broken && kind === 'wormhole') {
        // The sig you warp to lives in the FROM system. Prefer the explicitly
        // linked sig for this hop's direction; otherwise auto-match the
        // from-system wormhole sig whose "leads to" points at the target.
        const fromSigs = sigsBySystem.get(fromId) ?? [];
        const sigRef = conn.sourceId === fromId ? conn.sourceSignatureId
                     : conn.targetId === fromId ? conn.targetSignatureId
                     : null;
        let sig = sigRef ? fromSigs.find((s) => s.id === sigRef) : undefined;
        if (!sig) {
          const to = sysById.get(toId);
          sig = fromSigs.find((s) => s.sigType === 'wormhole' && sigLeadsTo(s, to));
        }
        if (sig) {
          sigId = sig.sigId || null;
          if (!whType) whType = sig.whType || null; // fall back to the sig's code
        }
      }
    }

    steps.push({
      index: i + 1,
      fromId, toId,
      fromName: sysById.get(fromId)?.name ?? '?',
      toName:   sysById.get(toId)?.name ?? '?',
      kind, whType, sigId, broken,
    });
  }
  return steps;
}
