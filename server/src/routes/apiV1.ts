import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { authUser } from '../middleware/authContext.js';
import { getMapAccess } from './maps.js';
import { streamMapEvents } from '../services/mapStream.js';
import {
  listVisibleMaps, loadFullMap, isSystemInMap,
  loadSystemSignatures, loadSystemAnomalies, loadSystemStructures,
} from '../services/mapRead.js';

// Versioned, stable external read API. Authenticated by an account-scoped API
// key (Authorization: Bearer nxm_…); a browser session also works, so the same
// surface is usable from the app during development. Read-only in v1 — writes
// are a later, scope-gated phase. See external_api_feature.md.
//
// Shapes are deliberately decoupled from the cookie UI routes but currently
// share the same read loaders (services/mapRead.ts), so they match today and
// can be frozen independently later.
export const apiV1Router = Router();

// Resolve a Bearer key (if present) into req.apiAuth, then require SOME
// identity — a valid key or a logged-in session. No credential → 401.
apiV1Router.use(apiKeyAuth);
apiV1Router.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.apiAuth && !req.session.userId) {
    res.status(401).json({ error: 'API key required' });
    return;
  }
  next();
});

// GET /api/v1/maps — maps visible to the key's account.
apiV1Router.get('/maps', async (req, res) => {
  const me = authUser(req);
  const maps = await listVisibleMaps({
    userId:     me.userId,
    ownerId:    me.ownerId,
    userCorpId: me.corpId,
    callerChar: me.characterId,
  });
  res.json({ maps });
});

// GET /api/v1/maps/:mapId — full map (meta + systems + connections). Share-link
// fields are stripped: they're capability secrets the programmatic API has no
// reason to leak.
apiV1Router.get('/maps/:mapId', async (req, res) => {
  const { mapId } = req.params;
  if (!(await getMapAccess(mapId, req))) { res.status(404).json({ error: 'Map not found' }); return; }
  const full = await loadFullMap(mapId);
  if (!full) { res.status(404).json({ error: 'Map not found' }); return; }
  const {
    shareToken: _t, shareExpiresAt: _e,
    shareIncludeSigs: _s, shareIncludeBridges: _b,
    shareIncludeNotes: _n, shareIncludeStructures: _st,
    ...safe
  } = full as Record<string, unknown>;
  res.json(safe);
});

// Per-system intel. Each guards access on the map, then confirms the system
// belongs to it (cross-map IDOR + malformed-uuid guard) before loading.
async function systemScope(req: Request, res: Response): Promise<boolean> {
  const { mapId, systemId } = req.params;
  if (!(await getMapAccess(mapId, req))) { res.status(404).json({ error: 'Map not found' }); return false; }
  if (!(await isSystemInMap(systemId, mapId))) { res.status(404).json({ error: 'System not found' }); return false; }
  return true;
}

apiV1Router.get('/maps/:mapId/systems/:systemId/signatures', async (req, res) => {
  if (!(await systemScope(req, res))) return;
  res.json(await loadSystemSignatures(req.params.systemId));
});

apiV1Router.get('/maps/:mapId/systems/:systemId/anomalies', async (req, res) => {
  if (!(await systemScope(req, res))) return;
  res.json(await loadSystemAnomalies(req.params.systemId));
});

apiV1Router.get('/maps/:mapId/systems/:systemId/structures', async (req, res) => {
  if (!(await systemScope(req, res))) return;
  res.json(await loadSystemStructures(req.params.systemId));
});

// GET /api/v1/maps/:mapId/events — live SSE stream of map edits, the same feed
// the web client uses. Key clients need the 'events' scope (a plain 'read' key
// is refused); a logged-in session is also accepted. Document the event
// taxonomy as the public contract.
apiV1Router.get('/maps/:mapId/events', async (req, res) => {
  // Scope gate: 'read' keys can pull snapshots but not subscribe to the stream.
  // Session requests have no apiAuth and pass through.
  if (req.apiAuth && req.apiAuth.apiScope !== 'events') {
    res.status(403).json({ error: "API key needs the 'events' scope" });
    return;
  }
  const { mapId } = req.params;
  if (!(await getMapAccess(mapId, req))) { res.status(404).json({ error: 'Map not found' }); return; }
  streamMapEvents(req, res, mapId);
});
