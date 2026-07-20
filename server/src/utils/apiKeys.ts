import { randomBytes, createHash } from 'node:crypto';

// External API keys. Unlike the EVE OAuth tokens (encrypted at rest so they can
// be decrypted and replayed to ESI — see tokenCrypto.ts), an API key is only
// ever *compared*: we store a one-way sha-256 of it and throw the raw value
// away after showing it once. A DB leak then exposes no usable keys.

const PREFIX     = 'nxm_';
const PREFIX_LEN = 12;          // chars of the raw key surfaced for display ("nxm_3f9a…")
const KEY_BYTES  = 32;          // 256 bits of entropy, url-safe base64 (~43 chars)

export interface GeneratedKey {
  raw:    string;   // full secret, shown to the user exactly once
  hash:   string;   // sha-256 hex stored in api_tokens.token_hash
  prefix: string;   // leading chars stored in api_tokens.token_prefix for the list UI
}

// base64url without padding — compact, copy-paste safe, no '+' '/' '=' to escape.
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedKey {
  const raw = PREFIX + base64url(randomBytes(KEY_BYTES));
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, PREFIX_LEN) };
}

