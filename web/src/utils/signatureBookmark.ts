import type { Signature } from '../types';
import type { WormholeSpec } from '../hooks/useWormholeTypes';
import { whSizeClass, whSizeShort } from './wormholeSize';
import { whDestClass, isUnresolvedLeadsTo } from './whDest';

// Tokens the bookmark-name format understands. Also drives the legend shown
// next to the format setting.
export const BOOKMARK_TOKENS: { token: string; desc: string }[] = [
  { token: '{sig}',         desc: 'Full signature ID (ABC-123)' },
  { token: '{sig_letters}', desc: 'First 3 chars (ABC)' },
  { token: '{type}',        desc: 'Wormhole type code (D382)' },
  { token: '{dest_type}',   desc: 'Destination class (C5, HS)' },
  { token: '{leads_to}',    desc: 'Leads to — pinned system or class (J110555)' },
  { token: '{size}',        desc: 'Hole size (S / M / L / XL)' },
  { token: '{mass}',        desc: 'Total mass in billions (3.0)' },
  { token: '{age}',         desc: 'Hours since first seen (2h)' },
  { token: '{name}',        desc: 'Signature name' },
  { token: '{notes}',       desc: 'Signature notes' },
];

// No {age} by default: you bookmark a hole the moment it's scanned, so a
// created-at age is always ~0h at copy time. It stays an available token for
// anyone who wants it, just not in the default.
export const DEFAULT_BOOKMARK_FORMAT = '{sig} {dest_type} {size}';

// Per-jump mass -> short size letter. Reuses the canonical classifier in
// wormholeSize.ts so the bookmark {size} can never drift from the connection
// panel (it used to have its own off-by-one `<=` thresholds — a 62M/375M/1B
// hole is M/L/XL, not S/M/L). 0 (unknown, e.g. an un-typed K162) yields no letter.
function sizeLetter(jumpMassKg: number): string {
  const cls = whSizeClass(jumpMassKg);
  return cls ? whSizeShort(cls) : '';
}

// Matches the longest tokens first so {sig_letters} isn't eaten by {sig}.
const TOKEN_RE = /\{sig_letters\}|\{sig\}|\{type\}|\{dest_type\}|\{leads_to\}|\{size\}|\{mass\}|\{age\}|\{name\}|\{notes\}/g;

/**
 * Build an in-game bookmark name for a wormhole signature from a token format
 * string. Unfillable tokens collapse to empty and surrounding whitespace is
 * squeezed, so a partially-known sig still yields a tidy, paste-ready name.
 */
export function formatBookmarkName(
  format: string,
  sig: Signature,
  whTypes: Record<string, WormholeSpec> = {},
  now: number = Date.now(),
): string {
  // The full wormhole catalog (useWormholeTypes) keyed by type code — the small
  // static map only covers k-space statics, so most holes (e.g. A641) miss it.
  const wh   = sig.whType ? whTypes[sig.whType] : undefined;
  // {dest_type} is the destination CLASS — from the wormhole type (D364 -> C2),
  // falling back to the leads-to only when that is itself a class/band (e.g. a
  // K162 the user tagged "C4"), never a pinned system. {leads_to} carries the
  // raw leads-to: a pinned system (J110555) or the class/band the user set.
  const leadsToRaw = (sig.whLeadsTo ?? '').trim();
  const leadsTo    = leadsToRaw.toLowerCase() === 'unknown' ? '' : leadsToRaw;
  const destClass  = whDestClass(sig.whType, whTypes);
  const destType   = destClass ?? (leadsTo && isUnresolvedLeadsTo(leadsTo) ? leadsTo : '');
  const ageH = sig.createdAt
    ? Math.max(0, Math.floor((now - new Date(sig.createdAt).getTime()) / 3_600_000))
    : null;

  const subs: Record<string, string> = {
    '{sig}':         sig.sigId ?? '',
    '{sig_letters}': (sig.sigId ?? '').slice(0, 3).toUpperCase(),
    '{type}':        sig.whType ?? '',
    '{dest_type}':   destType,
    '{leads_to}':    leadsTo,
    '{size}':        wh ? sizeLetter(wh.maxJumpMass) : '',
    '{mass}':        wh && wh.totalMass ? String(Number((wh.totalMass / 1_000_000_000).toFixed(1))) : '',
    '{age}':         ageH != null ? `${ageH}h` : '',
    '{name}':        sig.name ?? '',
    '{notes}':       sig.notes ?? '',
  };

  return format.replace(TOKEN_RE, (m) => subs[m] ?? '').trim().replace(/\s+/g, ' ');
}
