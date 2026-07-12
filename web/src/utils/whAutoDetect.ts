import { useMapStore } from '../store/mapStore';
import type { Signature, MapConnection } from '../types';

/**
 * After a signature was edited or deleted, re-evaluate every connection that
 * touches `systemId` against the latest set of sigs on this system.
 *
 * For each such connection:
 *  - If any sig backs the link (whType + whLeadsTo, where whLeadsTo matches the
 *    other endpoint by class OR by name), fill / upgrade conn.type with the
 *    best non-K162 match.
 *  - If no sig backs it any more AND the previously-edited sig used to back
 *    it AND conn.type still matches that old whType, clear the connection
 *    back to `null` (so it's eligible for auto-fill again).
 *  - User-cleared connections (conn.type === '') and unrelated manual values
 *    are left alone.
 *
 * The `oldSig` argument is the sig's state BEFORE the edit/delete — it lets us
 * detect "this sig used to back this connection" so we don't accidentally
 * clear a value the user typed manually.
 */
export function reevaluateConnectionsForSystem(
  systemId: string,
  allSigs:  Signature[],
  oldSig:   Signature | undefined,
  // When true, a connection that this (deleted) sig used to back is QUARANTINED
  // — flagged `broken` rather than just having its type cleared — because a sig
  // vanishing means the wormhole collapsed. Used by sig deletion / overwrite-
  // paste; sig edits pass false and keep the old "clear the type" behaviour.
  breakOnOrphan = false,
): void {
  const { map, updateConnection } = useMapStore.getState();
  const oldType  = oldSig?.whType?.toUpperCase();
  const oldLeads = oldSig?.whLeadsTo?.toUpperCase();

  for (const conn of map.connections) {
    // Only wormhole ('standard') connections carry a WH type — skip gates and
    // Ansiblex links so a sig that leads to a bare class ("HS") can't stamp a
    // WH code onto a gate link to a same-class neighbour.
    if (conn.connectionType !== 'standard') continue;
    const otherId =
      conn.sourceId === systemId ? conn.targetId :
      conn.targetId === systemId ? conn.sourceId :
      null;
    if (!otherId) continue;
    const otherSys = map.systems.find(s => s.id === otherId);
    if (!otherSys) continue;
    const oc = otherSys.systemClass.toUpperCase();
    const on = (otherSys.name ?? '').toUpperCase();

    // Sigs on this system that back the link: a scanned wormhole whose leads-to
    // points at the other endpoint, by exact system name (pinned) or by class.
    const backing = allSigs.filter(
      (s) => s.whType && s.whLeadsTo &&
        (s.whLeadsTo.toUpperCase() === oc || s.whLeadsTo.toUpperCase() === on),
    );
    const backingCodes = backing.map((s) => (s.whType ?? '').toUpperCase());
    const best = backingCodes.find(t => t !== 'K162') ?? backingCodes[0];

    // True when this connection's current type was auto-filled from the sig
    // being re-evaluated (its OLD whType still equals conn.type, and its old
    // leadsTo pointed at the other endpoint). Lets us follow edits to that sig
    // without clobbering a type the user typed by hand.
    const oldBackedThis = !!(
      oldType && oldLeads &&
      (oldLeads === oc || oldLeads === on) &&
      conn.type && conn.type.toUpperCase() === oldType
    );

    const patch: Partial<Omit<MapConnection, 'id'>> = {};

    if (best) {
      if (conn.broken) {
        // A sig backs this link again (e.g. it reappeared in a re-scan) —
        // un-quarantine it and restore the type.
        patch.broken = false; patch.type = best;
      } else if (conn.type === null || (conn.type.toUpperCase() === 'K162' && best !== 'K162')) {
        // Empty, or a K162 placeholder being upgraded to a real code.
        patch.type = best;
      } else if (oldBackedThis && conn.type.toUpperCase() !== best.toUpperCase()) {
        // The sig that auto-filled this connection had its WH type changed —
        // follow it so editing a sig's type updates the map label too.
        patch.type = best;
      }
      // else: '' (user cleared) or a manual real code — leave the type.

      // Record which sig backs this end so "Backing signatures" fills in
      // automatically instead of only ever being set by hand. Only when the
      // backing sig is UNAMBIGUOUS — a single hole pinned to the exact connected
      // system, or the sole backing hole on this end — and never overriding a
      // manual link. (A K162 twin pinned to the same system alongside the real
      // code is fine: the real code wins as the single non-K162 pinned hole.)
      const endField = conn.sourceId === systemId ? 'sourceSignatureId' : 'targetSignatureId';
      if (!conn[endField]) {
        const pinned = backing.filter((s) => (s.whLeadsTo ?? '').toUpperCase() === on);
        const pinnedReal = pinned.filter((s) => (s.whType ?? '').toUpperCase() !== 'K162');
        const linkSig =
          pinnedReal.length === 1 ? pinnedReal[0] :
          pinned.length === 1     ? pinned[0]     :
          pinned.length === 0 && backing.length === 1 ? backing[0] :
          undefined; // several plausible holes — ambiguous, leave it to the user
        if (linkSig) patch[endField] = linkSig.id;
      }
    } else if (oldBackedThis && !conn.broken) {
      // No sig backs the connection any more. If this sig used to back it:
      //  - on a delete (breakOnOrphan), quarantine it — the hole collapsed, so
      //    sever the chain visually but keep it traceable;
      //  - on an edit, just clear the orphaned auto-filled type as before.
      if (breakOnOrphan) patch.broken = true; else patch.type = null;
    }

    if (Object.keys(patch).length) updateConnection(conn.id, patch);
  }
}
