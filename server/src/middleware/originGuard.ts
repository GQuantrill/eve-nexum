import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('origin-guard');

// Methods that mutate state. GET / HEAD / OPTIONS are read-only or
// preflight; CSRF on those isn't a thing.
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Strip trailing slashes with a linear scan rather than `/\/+$/`, which is
// O(n^2) on a long run of slashes (polynomial ReDoS) — and the Origin/Referer
// headers this runs on are attacker-influenced.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
}

/**
 * Defense-in-depth CSRF guard. Rejects state-changing requests whose
 * Origin (or Referer as a fallback) doesn't match FRONTEND_URL.
 *
 * SameSite=lax already blocks the browser from sending the session cookie
 * on most cross-site POSTs, so this is belt-and-braces — it catches the
 * residual edge cases (older browsers, CORS misconfigurations, browser
 * extensions that strip SameSite, etc.).
 *
 * Why not a token? The Origin header is automatically set by every
 * mainstream browser on cross-origin requests and cannot be forged or
 * suppressed by a malicious page. That's strictly cheaper than a CSRF
 * token (no rotation, no shared secret, no client-side wiring) and gives
 * equivalent protection for our threat model.
 *
 * The OAuth callback is GET-only so it's exempt by the method check —
 * EVE SSO redirects in via top-level navigation, which the OAuth state
 * param verifies separately.
 */
export function originGuard(allowedOrigin: string) {
  // Normalise once: strip trailing slash so '.../app' and '.../app/'
  // both match without per-request string juggling.
  const allowed = stripTrailingSlashes(allowedOrigin);

  return function originGuardMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!STATE_METHODS.has(req.method)) {
      next();
      return;
    }

    // Bearer-authenticated API requests are exempt. CSRF relies on *ambient*
    // credentials (the session cookie a browser attaches automatically); an
    // API key must be set explicitly by the caller via the Authorization
    // header, which a malicious cross-site page can neither read nor attach
    // (and a cross-origin request can't set it without a CORS preflight we
    // control). So these requests can't be CSRF and legitimately have no
    // browser Origin. apiKeyAuth still validates the key downstream.
    if ((req.headers.authorization ?? '').toLowerCase().startsWith('bearer ')) {
      next();
      return;
    }

    const origin  = stripTrailingSlashes(req.headers.origin ?? '');
    const referer = req.headers.referer ?? '';

    // Origin is the strong signal — when present, it's authoritative.
    if (origin) {
      if (origin === allowed) { next(); return; }
      log.warn(`${req.method} ${req.originalUrl} rejected: origin "${origin}" != "${allowed}"`);
      res.status(403).json({ error: 'Cross-origin request blocked' });
      return;
    }

    // Some clients (curl, native apps, server-to-server) don't send
    // Origin. Fall back to Referer when present. If neither is set, the
    // request is almost certainly not coming from a browser — reject to
    // be safe; legitimate API consumers should send one of them.
    if (referer.startsWith(`${allowed}/`) || referer === allowed) {
      next();
      return;
    }

    log.warn(`${req.method} ${req.originalUrl} rejected: no matching Origin/Referer`);
    res.status(403).json({ error: 'Cross-origin request blocked' });
  };
}
