/** Every ghost site's name ends this way, whatever the faction or tier. */
export const GHOST_SUFFIX = /covert research facility$/i;

/**
 * Ghost-site tiers. The tier is what matters operationally: it sets the
 * explosion damage if a can pops and how hard the rats hit, and it tracks the
 * space the site spawns in.
 *
 * `match` reads the tier out of a pasted site name; `value` is what gets
 * stored when a scout picks one by hand. Standard has no tier word — it's the
 * plain "<Faction> Covert Research Facility" — so it never matches by name and
 * is the fallback below.
 */
export type GhostSpaceKey = 'ghostTier.hisec' | 'ghostTier.lowsec' | 'ghostTier.nullWh' | 'ghostTier.wh';

export const GHOST_TIERS: { value: string; match: RegExp | null; space: GhostSpaceKey }[] = [
  { value: 'Lesser',   match: /\blesser\b/i,   space: 'ghostTier.hisec'  },
  { value: 'Standard', match: null,            space: 'ghostTier.lowsec' },
  { value: 'Improved', match: /\bimproved\b/i, space: 'ghostTier.nullWh' },
  { value: 'Superior', match: /\bsuperior\b/i, space: 'ghostTier.wh'     },
];

/**
 * Tier + expected space for a ghost site, or null when it isn't one.
 *
 * A hand-picked `ghostType` wins; otherwise the tier is read from the name,
 * which is what a pasted scan gives you. Reported, never enforced — naming is
 * CCP's and the community's sources disagree at the edges, so a mismatch is
 * shown as information rather than treated as bad data.
 */
export function ghostTier(
  sigType: string,
  name: string,
  ghostType = '',
): { tier: string; space: GhostSpaceKey } | null {
  if (sigType !== 'ghost') return null;

  const picked = GHOST_TIERS.find((t) => t.value === ghostType);
  if (picked) return { tier: picked.value, space: picked.space };

  for (const t of GHOST_TIERS) {
    if (t.match && t.match.test(name)) return { tier: t.value, space: t.space };
  }
  // No tier word: the plain "<Faction> Covert Research Facility", found in
  // low-sec. Only claim that for something that really is a ghost site name —
  // a blank or hand-typed row shows nothing rather than a guess.
  return GHOST_SUFFIX.test(name) ? { tier: 'Standard', space: 'ghostTier.lowsec' } : null;
}
