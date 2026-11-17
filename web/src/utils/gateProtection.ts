import type { MapConnection, MapSystem } from '../types';
import { isDefiniteWormholeHop, prefetchStargateNeighbors } from './stargateAdjacency';

// Stargates are fixed in the game, so a map with protectGates on (the default)
// won't let one be deleted or retyped. The server enforces it against the SDE
// (services/connectionRules.ts isProtectedGate); this mirrors it so the UI can
// refuse up front instead of removing the edge and having the server say no.
//
// Like the server, only a 'gate' whose ends really are stargate neighbours is
// protected. A 'gate' left between non-neighbours (from before the type was
// validated) stays removable. When the neighbours aren't cached yet this
// assumes protected and starts loading them, so a retry a moment later gets
// the definite answer.
export function isProtectedGate(
  conn: Pick<MapConnection, 'connectionType' | 'sourceId' | 'targetId'> | undefined,
  map: { protectGates?: boolean; systems: Pick<MapSystem, 'id' | 'eveSystemId'>[] },
): boolean {
  if (!conn || conn.connectionType !== 'gate' || map.protectGates === false) return false;
  const src = map.systems.find((s) => s.id === conn.sourceId)?.eveSystemId;
  const tgt = map.systems.find((s) => s.id === conn.targetId)?.eveSystemId;
  if (src == null || tgt == null) return false;
  prefetchStargateNeighbors(src);
  return !isDefiniteWormholeHop(src, tgt);
}
