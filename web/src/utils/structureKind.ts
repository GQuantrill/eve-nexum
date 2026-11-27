// Useful Systems > corp structures: which kind of Upwell structure to look
// for. Matched on the type name, so faction variants ('Moreau' Fortizar,
// Upwell Palatine Keepstar...) fall in with their hull.

export type StructureKind = 'all' | 'citadel' | 'engineering' | 'refinery';
export const STRUCTURE_KINDS: StructureKind[] = ['all', 'citadel', 'engineering', 'refinery'];

const HULLS: Record<Exclude<StructureKind, 'all'>, string[]> = {
  citadel:     ['Astrahus', 'Fortizar', 'Keepstar'],
  engineering: ['Raitaru', 'Azbel', 'Sotiyo'],
  refinery:    ['Athanor', 'Tatara'],
};

/**
 * True when a structure of this type counts for the kind. 'all' is every
 * structure you can dock at, so not Ansiblexes, cyno beacons or moon drills.
 */
export function structureKind(typeName: string, kind: StructureKind): boolean {
  const is = (hulls: string[]) => hulls.some((h) => typeName.includes(h));
  if (kind === 'all') return Object.values(HULLS).some(is);
  return is(HULLS[kind]);
}
