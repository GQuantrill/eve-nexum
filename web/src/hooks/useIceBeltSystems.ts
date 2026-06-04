import { createStaticResource } from './createStaticResource';

// Static cluster data — load once per page, never refresh. The id list is
// transformed into a Set for O(1) membership checks.
const { useResource } = createStaticResource<number[], Set<number>>(
  '/api/systems/ice-belts',
  new Set<number>(),
  (ids) => new Set(ids),
);
export const useIceBeltSystems = useResource;

export function hasIceBelt(set: Set<number>, eveSystemId: number | null): boolean {
  return !!eveSystemId && set.has(eveSystemId);
}
