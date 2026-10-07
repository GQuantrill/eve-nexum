import type { Signature } from '../types';

// Relic/data site safety, keyed on the first word of the scanned site name (per
// the site-safety table). "Safe" sites have no NPCs; "not safe" ones can spawn
// combat. Only relic + data sigs qualify; anything else has no safety verdict.
const SAFE_SITE_PREFIXES   = new Set(['crumbling', 'decayed', 'ruined', 'local', 'regional', 'central']);
const UNSAFE_SITE_PREFIXES = new Set(['forgotten', 'unsecured', 'aegis', 'scc']);

// Event data sites that are safe to warp to, matched on the WHOLE name rather
// than a first word like the standard sites above.
//
// Event names share their first word across the whole event -- a "Crimson
// Harvest" data site and a Crimson Harvest combat site open the same way -- so
// keying on "crimson" would vouch for sites nobody has checked. Each entry here
// is one that has actually been confirmed safe.
//
// This list dates, unlike the prefix rules: events rotate and CCP names each
// one's sites afresh, so expect to add to it rather than to find it complete.
const SAFE_SITE_NAMES = new Set([
  // Crimson Harvest
  'crimson harvest network node',
  'crimson harvest network hub',
  // Tetrimon
  'tetrimon network node',
  'tetrimon network hub',
  // Wightstorm
  'wightstorm comms relay',
  'wightstorm strategic node',
  'wightstorm crypto facility',
]);

export function siteSafety(sig: Pick<Signature, 'sigType' | 'name'>): 'safe' | 'unsafe' | null {
  if (sig.sigType !== 'relic' && sig.sigType !== 'data') return null;
  const words = (sig.name ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Names can be prefixed with "Detected " (e.g. "Detected Central Sansha…"),
  // so both the full name and the safety keyword skip that word.
  const rest = words[0] === 'detected' ? words.slice(1) : words;
  if (rest.length === 0) return null;

  // Whole-name matches first: an event site is a specific site, not a family.
  if (SAFE_SITE_NAMES.has(rest.join(' '))) return 'safe';

  const key = rest[0];
  if (SAFE_SITE_PREFIXES.has(key))   return 'safe';
  if (UNSAFE_SITE_PREFIXES.has(key)) return 'unsafe';
  return null;
}
