import { ghostTier } from './ghostSites';
import type { Signature } from '../types';

/**
 * The value a signature column sorts on.
 *
 * Two columns do not sort on their stored value:
 *
 *  - Group. An unscanned signature is stored as 'unknown', which sorts
 *    alphabetically between Ore and Wormhole -- so a system with a lot of gas
 *    buries the sigs you still have to scan. In the game that field is BLANK
 *    for an unscanned sig, so it sorts to the top ascending and the bottom
 *    descending, and working down the unscanned ones is the normal way to
 *    scan a new system. Treating it as an empty string reproduces that
 *    exactly, including the descending case -- rather than pinning it to the
 *    top in both directions, which the game does not do.
 *
 *  - Type, for ghost sites. That column shows the tier rather than a wormhole
 *    code, so sorting on whType alone made every ghost row sort as blank.
 */
export function sigSortKey(s: Signature, sortCol: string): string {
  if (sortCol === 'sigType') {
    return s.sigType === 'unknown' ? '' : s.sigType;
  }
  if (sortCol === 'whType' && s.sigType === 'ghost') {
    return ghostTier(s.sigType, s.name, s.ghostType)?.tier ?? '';
  }
  // One contained cast: the caller's column is a runtime string, and every
  // sortable column holds a string or null.
  const v = (s as unknown as Record<string, unknown>)[sortCol];
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}
