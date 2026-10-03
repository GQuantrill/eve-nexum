import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { readPresetsFor } from '../services/flagPresets.js';

// The org's connection-flag presets, for ordinary members.
//
// Corp-scoped config has until now been consumed server-side only (the Discord
// filters are applied when deciding whether to post), so no member-facing read
// existed. Flag presets are different: the member's own client renders the list,
// so it has to reach them.
//
// Read-only and auth-gated, never admin-gated -- the whole point is that every
// member sees the standard their admin set. The org is resolved from the
// session, so nothing here trusts client input or exposes the corp id.
const log = createLogger('flagPresets');
export const flagPresetsRouter = Router();
flagPresetsRouter.use(requireAuth);

// GET /api/flag-presets
flagPresetsRouter.get('/', async (req, res) => {
  try {
    res.json(await readPresetsFor(req));
  } catch (err) {
    // A failure here must not break flagging: the client falls back to personal
    // presets and the free-choice picker.
    log.error('read failed:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});
