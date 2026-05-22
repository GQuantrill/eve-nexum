import type { Request, Response, NextFunction } from 'express';
import { lookupShareToken } from '../routes/share.js';

/**
 * Allows a request through when *either* of:
 *   - The user has a valid session (req.session.userId is set), OR
 *   - The request carries ?shareToken=<uuid> matching a non-expired map.
 *
 * Used on the public-data ESI proxy routes (/api/killboard, /api/activity,
 * /api/incursions, /api/insurgency, /api/stats, /api/systems/*) so that
 * read-only share viewers can populate the same panes a signed-in user
 * sees without us having to duplicate the routes.
 *
 * On the share-token path:
 *   - Sets req.shareMapId (string) so individual handlers can scope reads
 *     to that map if they want to (e.g. system membership checks).
 *   - Does NOT set req.session.userId — handlers that need a real user
 *     should still fail on those routes (we don't put writes behind this).
 *
 * Failures emit the same 401 shape as requireAuth so the client's existing
 * error handling continues to work.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.userId) { next(); return; }

  const token = typeof req.query.shareToken === 'string' ? req.query.shareToken : '';
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const lookup = await lookupShareToken(token);
    if (lookup.status !== 'valid') {
      // 401 (not 410) so the SPA's auth-failure handling fires and the
      // viewer is bounced to a "link expired" screen — not because the
      // user logged out.
      res.status(401).json({ error: 'Share link invalid or expired' });
      return;
    }
    (req as Request & { shareMapId?: string }).shareMapId = lookup.mapId;
    next();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
}
