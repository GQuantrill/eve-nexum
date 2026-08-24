import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { useCanEdit } from './useCanEdit';
import { useWormholeTypes } from './useWormholeTypes';
import { whDestClass, leadsToClasses } from '../utils/whDest';
import type { MapSystem } from '../types';

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
export function useReviveBackedConnections() {
  const canEdit = useCanEdit();
  const systems = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const whSigsBySystem = useMapStore((s) => s.whSigsBySystem);
  const updateConnection = useMapStore((s) => s.updateConnection);
  const whTypes = useWormholeTypes();

  useEffect(() => {
    if (!canEdit) return;
    const byId = new Map(systems.map((s) => [s.id, s]));

    // Does `fromId` carry a wormhole sig that plausibly leads to `to`? Matched by
    // pinned system name first (exact), then destination class (the sig's
    // leads-to token or its fixed-destination code) — mirrors the quarantine's
    // leads-to matching elsewhere in the app.
    const backs = (fromId: string, to: MapSystem): boolean => {
      const name = (to.name ?? '').trim().toUpperCase();
      for (const sig of whSigsBySystem[fromId] ?? []) {
        const leads = (sig.leadsTo ?? '').trim().toUpperCase();
        if (leads && name && leads === name) return true;
        if (leadsToClasses(sig.leadsTo).includes(to.systemClass)) return true;
        if (whDestClass(sig.whType, whTypes) === to.systemClass) return true;
      }
      return false;
    };

    for (const conn of connections) {
      if (conn.connectionType !== 'standard' || !conn.broken) continue;
      const a = byId.get(conn.sourceId);
      const b = byId.get(conn.targetId);
      if (!a || !b) continue;
      if (backs(a.id, b) && backs(b.id, a)) updateConnection(conn.id, { broken: false });
    }
  }, [canEdit, systems, connections, whSigsBySystem, whTypes, updateConnection]);
}
