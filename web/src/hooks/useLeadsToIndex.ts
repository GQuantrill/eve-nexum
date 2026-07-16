import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { useWormholeTypes } from './useWormholeTypes';
import { whDestClass, leadsToClasses } from '../utils/whDest';
import type { SystemClass } from '../types';

/**
 * Mounted once (in MapCanvas). Builds the per-system "leads to" index: for each
 * system, the set of destination classes its wormholes reach. A wormhole's
 * destination is resolved from every source we have, so a hole counts however we
 * learned where it goes:
 *   - statics: the type's fixed destination (SDE-authoritative via whDestClass),
 *   - scanned wormhole sigs: fixed-destination code, a leads-to band/class token,
 *     or a pinned connected-system name -> that system's class,
 *   - live connections: the connected system's class (a solved hole, e.g. an HS
 *     system linked to a C4 leads to C4 even when its own sig has no code).
 * Recomputes when the systems, connections, scanned sigs or the wh-type catalog
 * change; the result feeds the watchlist "leads to" match as a plain lookup.
 */
export function useLeadsToIndex() {
  const systems = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const whSigsBySystem = useMapStore((s) => s.whSigsBySystem);
  const setLeadsToClasses = useMapStore((s) => s.setLeadsToClasses);
  const whTypes = useWormholeTypes();

  useEffect(() => {
    const byId = new Map(systems.map((s) => [s.id, s]));
    const nameToClass = new Map<string, SystemClass>();
    for (const s of systems) if (s.name) nameToClass.set(s.name.trim().toUpperCase(), s.systemClass);

    const sets: Record<string, Set<SystemClass>> = {};
    const ensure = (id: string): Set<SystemClass> => (sets[id] ??= new Set<SystemClass>());

    for (const s of systems) {
      const set = ensure(s.id);
      for (const st of s.statics) { const c = whDestClass(st, whTypes); if (c) set.add(c); }
      for (const sig of whSigsBySystem[s.id] ?? []) {
        const byCode = whDestClass(sig.whType, whTypes);
        if (byCode) set.add(byCode);
        for (const c of leadsToClasses(sig.leadsTo)) set.add(c);
        const pinned = (sig.leadsTo ?? '').trim();
        const byName = pinned ? nameToClass.get(pinned.toUpperCase()) : undefined;
        if (byName) set.add(byName);
      }
    }
    // Live connections: each endpoint leads to the other's class.
    for (const conn of connections) {
      const a = byId.get(conn.sourceId);
      const b = byId.get(conn.targetId);
      if (a && b) { ensure(a.id).add(b.systemClass); ensure(b.id).add(a.systemClass); }
    }

    const out: Record<string, SystemClass[]> = {};
    for (const id in sets) out[id] = [...sets[id]];
    setLeadsToClasses(out);
  }, [systems, connections, whSigsBySystem, whTypes, setLeadsToClasses]);
}
