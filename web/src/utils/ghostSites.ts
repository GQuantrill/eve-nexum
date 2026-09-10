/** Every ghost site's name ends this way, whatever the faction or tier. */
export const GHOST_SUFFIX = /covert research facility$/i;

/**
 * Ghost-site tier, read from the name. The tier is what matters operationally:
 * it sets the explosion damage if a can pops and how hard the rats hit, and it
 * tracks the space the site spawns in.
 *
 * Reported, never enforced. Naming is CCP's and the community's sources
 * disagree at the edges, so a mismatch is shown as information rather than
 * treated as bad data.
 */
type GhostSpaceKey = 'ghostTier.hisec' | 'ghostTier.lowsec' | 'ghostTier.nullWh' | 'ghostTier.wh';
const GHOST_TIERS: { match: RegExp; tier: string; space: GhostSpaceKey }[] = [
  { match: /\blesser\b/i,   tier: 'Lesser',   space: 'ghostTier.hisec'  },
  { match: /\bimproved\b/i, tier: 'Improved', space: 'ghostTier.nullWh' },
  { match: /\bsuperior\b/i, tier: 'Superior', space: 'ghostTier.wh'     },
];

/** Tier + expected space for a ghost site, or null when it isn't one. */
export function ghostTier(sigType: string, name: string): { tier: string; space: GhostSpaceKey } | null {
  if (sigType !== 'ghost') return null;
  for (const t of GHOST_TIERS) if (t.match.test(name)) return { tier: t.tier, space: t.space };
  // No tier word: the plain "<Faction> Covert Research Facility", found in
  // low-sec.
  return GHOST_SUFFIX.test(name) ? { tier: 'Standard', space: 'ghostTier.lowsec' } : null;
}

