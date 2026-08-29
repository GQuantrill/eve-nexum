import rateLimit from 'express-rate-limit';

// Tight: auth + OAuth callback. State brute-force, login spam.
export const authLimiter = rateLimit({
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
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Unauthenticated routes (search) — IP-keyed.
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
  windowMs: 60_000,
  limit: 360,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
