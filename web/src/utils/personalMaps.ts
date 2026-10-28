import type { MapListItem } from '../store/mapStore';

/**
 * How many of these maps count against the PERSONAL map limit: the ones the
 * caller owns. Corp and alliance maps have their own limits, and a map merely
 * shared with the caller (hidden or not) belongs to someone else. Matches the
 * server's count (services/mapAllowance.ts: owner_id, corp/alliance NULL).
 *
 * One helper for every place that gates on the limit, so they can't disagree
 * -- the New Map dialog once counted shared maps and refused a fifth map to
 * someone with four.
 */
export function countPersonalMaps(maps: MapListItem[]): number {
  return maps.filter((m) => !m.isCorpMap && !m.isAllianceMap && !m.sharedWithMe).length;
}
