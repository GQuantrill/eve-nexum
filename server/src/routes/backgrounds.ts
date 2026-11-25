import { Router, type Response } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { backgroundReadScope, listBackgrounds, readBackgroundImage } from '../services/orgBackgrounds.js';

// The map backgrounds a member's admin offers (services/orgBackgrounds.ts).
// Read-only and auth-gated; the org comes from the session, never the client.
const log = createLogger('backgrounds');
export const backgroundsRouter = Router();
backgroundsRouter.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Send a stored picture. Its id never points at other bytes, so the browser
 *  may keep it; private, since it's only for this org's members. */
export function sendBackgroundImage(res: Response, img: { mime: string; data: Buffer } | null): void {
  if (!img) { res.status(404).json({ error: 'Not found' }); return; }
  res.set({
    'Content-Type': img.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.send(img.data);
}

// GET /api/backgrounds -- { enabled, backgrounds: [{ id, name, isDefault }] }.
// enabled is false on a solo install (no org), where the settings hide the
// choice altogether.
backgroundsRouter.get('/', async (req, res) => {
  try {
    const scope = await backgroundReadScope(req);
    res.json({ enabled: !!scope, backgrounds: scope ? await listBackgrounds(scope) : [] });
  } catch (err) {
    log.error('list failed:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// GET /api/backgrounds/:id -- the picture, if it is one of this member's org's.
backgroundsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const scope = await backgroundReadScope(req);
    sendBackgroundImage(res, scope ? await readBackgroundImage(scope, id) : null);
  } catch (err) {
    log.error('image read failed:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});
