import type { SystemClass } from '../types';
import type { MapConnection } from '../types';
import { WORMHOLE_DESTINATIONS } from '../data/wormholes';

// A "scanned but not dived" wormhole: you know a hole is here (and maybe its
// type/destination class) but you haven't jumped it, so no connection on the
// map represents it. Shown as a pill under the node and offered in the content
// filter, so potential exits/dangers are visible without diving them.

// A minimal per-system wormhole signature, indexed map-wide from /signatures.
export interface WhSig {
  id:       string;   // signature row id (uuid) — matches a connection's backing sig
  sigId:    string;   // human scan id, e.g. "KHF-920"
  whType:   string;   // wormhole code, e.g. "U210" ("" / "K162" when unknown)
  leadsTo:  string;   // pinned system name, a class/band token, or "" / "unknown"
}

// A resolved undived hole, ready to render: its scan id, code, and the
// destination class we can colour it by (null when unknown).
export interface UndivedHole {
  id:    string;
  sigId: string;
  code:  string;
  dest:  SystemClass | null;
}

// leads-to values that are a class/band/unknown rather than a pinned system —
// mirrors whJumpConfirm's set. A leads-to NOT in here is a specific connected
// system, i.e. the hole is already solved. (Legacy exact C-classes included.)
const CLASS_OR_UNKNOWN = new Set([
  '', 'UNKNOWN',
  'C1-C3', 'C4-C5', 'C6', 'C13', 'THERA', 'POCHVEN', 'DRIFTER',
  'HS', 'LS', 'NS',
  'C1', 'C2', 'C3', 'C4', 'C5',
]);

// A hole is unresolved while its leads-to is still a class/band/unknown (not
// pinned to a specific system).
function isUnresolvedLeadsTo(leadsTo: string): boolean {
  return CLASS_OR_UNKNOWN.has((leadsTo || '').trim().toUpperCase());
}

// The destination class to colour a hole by: from the wormhole type first
// (e.g. U210 -> LS), else the leads-to when it's itself an exact class token,
// else null (unknown -> neutral).
function destForHole(code: string, leadsTo: string): SystemClass | null {
  const byType = WORMHOLE_DESTINATIONS[(code || '').toUpperCase()];
  if (byType) return byType;
  const lt = (leadsTo || '').trim().toUpperCase();
  const asClass = ({
    C1: 'C1', C2: 'C2', C3: 'C3', C4: 'C4', C5: 'C5', C6: 'C6', C13: 'C13',
    HS: 'HS', LS: 'LS', NS: 'NS', THERA: 'Thera', POCHVEN: 'Pochven', DRIFTER: 'Drifter',
  } as Record<string, SystemClass>)[lt];
  return asClass ?? null;
}

// The undived holes for one system: wormhole sigs whose leads-to is still
// unresolved AND which don't already back a connection (a dived hole gets a
// connection, and — via the backing-sig auto-link — its sig linked to it).
export function undivedForSystem(sigs: WhSig[], connections: MapConnection[]): UndivedHole[] {
  const backing = new Set<string>();
  for (const c of connections) {
    if (c.sourceSignatureId) backing.add(c.sourceSignatureId);
    if (c.targetSignatureId) backing.add(c.targetSignatureId);
  }
  const out: UndivedHole[] = [];
  for (const s of sigs) {
    if (!isUnresolvedLeadsTo(s.leadsTo)) continue; // pinned to a system — solved
    if (backing.has(s.id)) continue;               // already backs a connection
    out.push({ id: s.id, sigId: s.sigId, code: s.whType, dest: destForHole(s.whType, s.leadsTo) });
  }
  return out;
}

// Map-wide index: undived holes per system, from the per-system wh-sig index
// and the current connections.
export function undivedIndex(
  whSigsBySystem: Record<string, WhSig[]>,
  connections: MapConnection[],
): Record<string, UndivedHole[]> {
  const out: Record<string, UndivedHole[]> = {};
  for (const systemId in whSigsBySystem) {
    const holes = undivedForSystem(whSigsBySystem[systemId], connections);
    if (holes.length) out[systemId] = holes;
  }
  return out;
}
