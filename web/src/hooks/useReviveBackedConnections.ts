import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCanEdit } from './useCanEdit';
import { useWormholeTypes } from './useWormholeTypes';
import { whDestClass, leadsToClasses, isUnresolvedLeadsTo } from '../utils/whDest';
import { collapseState } from '../utils/rolling';
import type { MapConnection, MapSystem } from '../types';
import type { WhSig } from '../utils/undivedWormholes';

/**
 * Mounted once (in MapCanvas). The missing mirror of the "quarantine orphaned
 * wormhole" logic: that SETS a connection `broken` when a scanned system has no
 * wormhole sig; nothing ever cleared it again on a re-scan, so `broken` was a
 * one-way latch — a hole scanned on both ends could stay flagged "broken —
 * re-scout" forever (a transient sig gap during an overwrite-paste / re-scan is
 * enough to latch it).
 *
 * This revives such connections: a live wormhole is scanned on BOTH ends (a sig
 * on each side leading to the other), so a broken standard link backed that way
 * is alive — clear `broken`, fixing the chain hop, routing and the greyed edge
 * at once. Requiring both ends (not either) keeps it from reviving a genuinely
 * half-collapsed hole where only a stale sig lingers on one side, and from
 * fighting the one-sided quarantine. Runs on map load (bulk whSigsBySystem) and
 * whenever sigs/connections change, so it heals the whole map, not just the
 * system in view. Idempotent: a revived connection is no longer broken.
 */
type WhTypeInfo = Record<string, { dest?: string; totalMass?: number } | undefined>;

/** The broken standard connections that sigs on both ends say are alive. Pure,
 *  so it can be tested without the store. */
export function connectionsToRevive(
  systems: MapSystem[],
  connections: MapConnection[],
  whSigsBySystem: Record<string, WhSig[]>,
  whTypes: WhTypeInfo,
): string[] {
  const byId = new Map(systems.map((s) => [s.id, s]));

  // Which connection each sig is linked to, so a sig already backing one hole
  // can't also be counted as backing another.
  const linkedTo = new Map<string, string>();
  for (const c of connections) {
    if (c.sourceSignatureId) linkedTo.set(c.sourceSignatureId, c.id);
    if (c.targetSignatureId) linkedTo.set(c.targetSignatureId, c.id);
  }

  // Does `fromId` carry a wormhole sig that plausibly leads to `to` over
  // `connId`? A sig linked to this connection does. A sig linked to another
  // connection, or pinned to another system by name, doesn't: matching those
  // by class revived holes that had really gone (home's H296 -> C5 to one C5
  // "backed" a dead link to a different C5). Only an unresolved sig (blank,
  // class or band) falls back to destination-class matching.
  const backs = (fromId: string, to: MapSystem, connId: string): boolean => {
    const name = (to.name ?? '').trim().toUpperCase();
    for (const sig of whSigsBySystem[fromId] ?? []) {
      const linked = linkedTo.get(sig.id);
      if (linked === connId) return true;
      if (linked) continue;
      if (!isUnresolvedLeadsTo(sig.leadsTo)) {
        if (name && sig.leadsTo.trim().toUpperCase() === name) return true;
        continue;
      }
      if (leadsToClasses(sig.leadsTo).includes(to.systemClass)) return true;
      if (whDestClass(sig.whType, whTypes) === to.systemClass) return true;
    }
    return false;
  };

  const out: string[] = [];
  for (const conn of connections) {
    if (conn.connectionType !== 'standard' || !conn.broken) continue;
    // Rolled shut: the calculator logged enough mass to collapse it. Its old
    // sigs are still listed on both ends (nobody re-scans a hole they just
    // rolled), which is exactly what this revive looks for, so without this
    // it undid every roll the moment it broke. Undo pass / Reset lower the
    // mass and restore the link themselves.
    const total = conn.type ? whTypes[conn.type.toUpperCase()]?.totalMass ?? 0 : 0;
    if (total > 0 && collapseState(total, conn.massUsed ?? 0) === 'collapsed') continue;
    const a = byId.get(conn.sourceId);
    const b = byId.get(conn.targetId);
    if (!a || !b) continue;
    if (backs(a.id, b, conn.id) && backs(b.id, a, conn.id)) out.push(conn.id);
  }
  return out;
}

export function useReviveBackedConnections() {
  const canEdit = useCanEdit();
  const systems = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const whSigsBySystem = useMapStore((s) => s.whSigsBySystem);
  const updateConnection = useMapStore((s) => s.updateConnection);
  const whTypes = useWormholeTypes();

  useEffect(() => {
    if (!canEdit) return;
    for (const id of connectionsToRevive(systems, connections, whSigsBySystem, whTypes)) {
      updateConnection(id, { broken: false });
    }
  }, [canEdit, systems, connections, whSigsBySystem, whTypes, updateConnection]);
}
