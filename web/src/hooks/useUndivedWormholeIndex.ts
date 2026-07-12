import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { undivedIndex } from '../utils/undivedWormholes';

/**
 * Mounted once (in MapCanvas). Derives the map-wide "undived wormholes" index
 * from the per-system wormhole-sig index and the current connections, and keeps
 * it in the store. Recomputes whenever a hole is scanned/edited (whSigsBySystem)
 * or a connection is added/removed/linked (map.connections) — so a hole drops
 * off the moment it's dived. Cheap: maps are tens of systems.
 */
export function useUndivedWormholeIndex() {
  const whSigsBySystem   = useMapStore((s) => s.whSigsBySystem);
  const connections      = useMapStore((s) => s.map.connections);
  const setUndivedWhBulk = useMapStore((s) => s.setUndivedWhBulk);

  useEffect(() => {
    setUndivedWhBulk(undivedIndex(whSigsBySystem, connections));
  }, [whSigsBySystem, connections, setUndivedWhBulk]);
}
