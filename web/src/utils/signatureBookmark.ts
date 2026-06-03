import type { Signature } from '../types';
import { WORMHOLE_TYPES } from '../data/wormholes';

// Tokens the bookmark-name format understands. Also drives the legend shown
// next to the format setting.
export const BOOKMARK_TOKENS: { token: string; desc: string }[] = [
  { token: '{sig}',         desc: 'Full signature ID (ABC-123)' },
  { token: '{sig_letters}', desc: 'First 3 chars (ABC)' },
  { token: '{type}',        desc: 'Wormhole type code (D382)' },
  { token: '{dest_type}',   desc: 'Destination class (C5, HS)' },
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

// Per-jump mass -> short size letter. Buckets are approximate and easy to
// tweak; 0 (unknown, e.g. an un-typed K162) yields no letter.
function sizeLetter(jumpMassKg: number): string {
  if (!jumpMassKg) return '';
  if (jumpMassKg <=    62_000_000) return 'S';
  if (jumpMassKg <=   375_000_000) return 'M';
  if (jumpMassKg <= 1_000_000_000) return 'L';
  return 'XL';
}

// Matches the longest tokens first so {sig_letters} isn't eaten by {sig}.
const TOKEN_RE = /\{sig_letters\}|\{sig\}|\{type\}|\{dest_type\}|\{size\}|\{mass\}|\{age\}|\{name\}|\{notes\}/g;

/**
 * Build an in-game bookmark name for a wormhole signature from a token format
 * string. Unfillable tokens collapse to empty and surrounding whitespace is
 * squeezed, so a partially-known sig still yields a tidy, paste-ready name.
 */
export function formatBookmarkName(format: string, sig: Signature, now: number = Date.now()): string {
  const wh   = sig.whType ? WORMHOLE_TYPES[sig.whType] : undefined;
  const dest = sig.whLeadsTo || wh?.leadsTo || '';
  const ageH = sig.createdAt
    ? Math.max(0, Math.floor((now - new Date(sig.createdAt).getTime()) / 3_600_000))
    : null;

  const subs: Record<string, string> = {
    '{sig}':         sig.sigId ?? '',
    '{sig_letters}': (sig.sigId ?? '').slice(0, 3).toUpperCase(),
    '{type}':        sig.whType ?? '',
    '{dest_type}':   dest,
    '{size}':        wh ? sizeLetter(wh.jumpMassKg) : '',
    '{mass}':        wh && wh.maxMassKg ? String(Number((wh.maxMassKg / 1_000_000_000).toFixed(1))) : '',
    '{age}':         ageH != null ? `${ageH}h` : '',
    '{name}':        sig.name ?? '',
    '{notes}':       sig.notes ?? '',
  };

  return format.replace(TOKEN_RE, (m) => subs[m] ?? '').trim().replace(/\s+/g, ' ');
}
