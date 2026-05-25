import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('origin-guard');

// Methods that mutate state. GET / HEAD / OPTIONS are read-only or
// preflight; CSRF on those isn't a thing.
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  const allowed = allowedOrigin.replace(/\/+$/, '');

  return function originGuardMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!STATE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin  = (req.headers.origin  ?? '').replace(/\/+$/, '');
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
