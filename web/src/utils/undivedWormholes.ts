import type { MapConnection } from '../types';

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

// An undived hole, ready to render. Its destination/colour is resolved at
// render time from the wormhole type (via the shared SDE-backed whDest helper)
// or the leads-to band — NOT precomputed here — so there's a single source of
// truth for wormhole destinations.
export interface UndivedHole {
  id:      string;
  sigId:   string;
  code:    string;
  leadsTo: string;
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
    out.push({ id: s.id, sigId: s.sigId, code: s.whType, leadsTo: s.leadsTo });
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
