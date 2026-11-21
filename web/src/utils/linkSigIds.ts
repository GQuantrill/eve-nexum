import type { MapConnection, MapSystem } from '../types';
import type { WhSig } from './undivedWormholes';

export const LINK_SIG_IDS_KEY = 'nexum.map.linkSigIds';

// How much each link shows on the map: everything (as always), or folded to a
// small marker you click to open, for maps with dozens of links. The line's
// own colour and core still carry life and mass when folded.
export const CONN_INFO_KEY = 'nexum.map.connInfo';
export type ConnInfoMode = 'full' | 'folded';

export interface LinkEndSigs { source: string | null; target: string | null }

// The sig you warp to at each end of a link: the one the link is backed by, or
// failing that the only sig in that system pinned to the far system by name.
// The same ties that keep a link alive (#719). A class-only match is a guess,
// and a wrong sig ID sends a scout to the wrong hole, so it shows nothing.
export function linkEndSigs(
  conn: Pick<MapConnection, 'sourceId' | 'targetId' | 'sourceSignatureId' | 'targetSignatureId'>,
  systemsById: ReadonlyMap<string, Pick<MapSystem, 'name'>>,
  whSigsBySystem: Readonly<Record<string, WhSig[]>>,
): LinkEndSigs {
  const end = (systemId: string, sigRowId: string | null | undefined, farId: string): string | null => {
    const sigs = whSigsBySystem[systemId] ?? [];
    if (sigRowId) {
      const backing = sigs.find((s) => s.id === sigRowId);
      if (backing) return backing.sigId || null;
    }
    const far = systemsById.get(farId)?.name?.toUpperCase();
    if (!far) return null;
    const pinned = sigs.filter((s) => (s.leadsTo ?? '').toUpperCase() === far);
    return pinned.length === 1 ? pinned[0].sigId || null : null;
  };
  return {
    source: end(conn.sourceId, conn.sourceSignatureId, conn.targetId),
    target: end(conn.targetId, conn.targetSignatureId, conn.sourceId),
  };
}

// What fits on the map: the three letters you pick out on the probe scanner.
export function shortSigId(sigId: string): string {
  return sigId.split('-')[0].slice(0, 3).toUpperCase();
}
