import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Limit authenticated traffic PER USER, falling back to IP for anonymous
 * requests.
 *
 * These limits were always described as per-session, but with no keyGenerator
 * express-rate-limit keys on `req.ip` — and `req.ip` is only as good as the
 * proxy-hop count. Get that wrong behind a reverse proxy and every request
 * resolves to the same address, collapsing the whole instance into one shared
 * bucket: one busy user then rate-limits everybody. Keying on the session makes
 * the authenticated limits mean what they say regardless of how many proxies
 * sit in front.
 *
 * ipKeyGenerator rather than raw req.ip for the anonymous case: it masks IPv6
 * to a /56 so a single client can't walk its own address space for a fresh
 * bucket per request.
 */
function userOrIpKey(req: Request): string {
  const userId = req.session?.userId;
  return userId != null ? `u:${userId}` : ipKeyGenerator(req.ip ?? '');
}

// Tight: auth + OAuth callback. State brute-force, login spam.
export const authLimiter = rateLimit({
  // Deliberately NOT keyed per user: this guards the SSO brute-force surface,
  // where by definition the caller has no session yet. IP is the only handle
  // there is, and keying it any other way would weaken the control.
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Looser: per-session ESI proxies (location, online, fleet, account-locations —
// all polled). Bounded by ESI's own rate limits anyway, but a runaway client
// shouldn't be able to spin our process. 300/min (5/sec) leaves headroom for a
// legit multi-tab / multi-character session — a few tabs each poll ~1.5/sec —
// while still stopping an actual runaway.
export const esiLimiter = rateLimit({
  keyGenerator: userOrIpKey,
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Unauthenticated routes (search) — genuinely IP-keyed, since there is no
// session to key on. Uses the library's default generator, which already
// applies the IPv6 masking described above.
export const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Authenticated app routes (maps, stats, standings, structures). Higher
// ceiling than esiLimiter because a busy mapping session legitimately
// fires many requests (sig save bursts, position drags, structure imports).
// 6/sec sustained is well above any realistic single-user need but stops a
// runaway / compromised account from saturating the DB pool.
export const appLimiter = rateLimit({
  keyGenerator: userOrIpKey,
  windowMs: 60_000,
  limit: 360,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
