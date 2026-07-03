import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { authUser } from '../middleware/authContext.js';
import { getMapAccess, requireMapContentWrite, dispatchK162, flushK162, resolveStructureOwnerCorp } from './maps.js';
import { streamMapEvents } from '../services/mapStream.js';
import {
  listVisibleMaps, loadFullMap, isSystemInMap,
  loadSystemSignatures, loadSystemAnomalies, loadSystemStructures,
} from '../services/mapRead.js';
import {
  createSignature, updateSignature, deleteSignature,
  createAnomaly, updateAnomaly, deleteAnomaly,
  createStructure, updateStructure, deleteStructure,
} from '../services/mapWrite.js';

// Versioned, stable external API. Authenticated by an account-scoped API key
// (Authorization: Bearer nxm_…); a browser session also works, so the same
// surface is usable from the app. Reads need any scope; the event stream needs
// 'events' (or 'write'); content writes need 'write'. Topology stays human-only.
// See external_api_feature.md.
//
// Shapes are deliberately decoupled from the cookie UI routes but share the
// same read/write services (mapRead.ts / mapWrite.ts), so they match today and
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
    userId:         me.userId,
    ownerId:        me.ownerId,
    userCorpId:     me.corpId,
    userAllianceId: me.allianceId,
    callerChar:     me.characterId,
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
  // Scope gate: a plain 'read' key can't subscribe to the stream; 'events' and
  // 'write' (the higher scope) can. Session requests have no apiAuth and pass.
  if (req.apiAuth && req.apiAuth.apiScope === 'read') {
    res.status(403).json({ error: "API key needs the 'events' scope" });
    return;
  }
  const { mapId } = req.params;
  if (!(await getMapAccess(mapId, req))) { res.status(404).json({ error: 'Map not found' }); return; }
  streamMapEvents(req, res, mapId);
});

// ── Content writes (requires a 'write'-scoped key) ─────────────────────────────
// Each guards via requireMapContentWrite (which enforces the write scope + the
// bound character's role) and confirms the system is in the map, then delegates
// to the same write services the cookie routes use. Topology (systems /
// connections) is intentionally not exposed — those stay human-only.

// Resolve the write context shared by every handler below.
function writeActor(req: Request) {
  return { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null };
}

// Guard: content-write access + the system belongs to the map. Returns the
// MapMeta (needed for K162 Discord scoping) or null once a response is sent.
async function writeScope(req: Request, res: Response) {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return null;
  if (!(await isSystemInMap(systemId, mapId))) { res.status(404).json({ error: 'System not found' }); return null; }
  return access;
}

// Signatures
apiV1Router.post('/maps/:mapId/systems/:systemId/signatures', async (req, res) => {
  const access = await writeScope(req, res); if (!access) return;
  const { mapId, systemId } = req.params;
  const { sigId = '', sigType = 'unknown', name = '', notes = '', whType = '', whLeadsTo = '' } = req.body as Record<string, string>;
  const row = await createSignature(mapId, systemId, { sigId, sigType, name, notes, whType, whLeadsTo }, writeActor(req));
  if ((whType ?? '').toUpperCase() === 'K162') dispatchK162(access, row.id, systemId, authUser(req).characterName);
  res.status(201).json(row);
});

apiV1Router.patch('/maps/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  const access = await writeScope(req, res); if (!access) return;
  const { mapId, systemId, sigId } = req.params;
  const { dispatchK162: shouldDispatch, flushK162: shouldFlush } =
    await updateSignature(mapId, systemId, sigId, req.body as Record<string, unknown>, writeActor(req));
  if (shouldDispatch) dispatchK162(access, sigId, systemId, authUser(req).characterName);
  if (shouldFlush) flushK162(sigId);
  res.json({ ok: true });
});

apiV1Router.delete('/maps/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId, sigId } = req.params;
  await deleteSignature(mapId, systemId, sigId, writeActor(req));
  res.json({ ok: true });
});

// Anomalies
apiV1Router.post('/maps/:mapId/systems/:systemId/anomalies', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId } = req.params;
  const { anomId = '', anomType = 'unknown', name = '', notes = '' } = req.body as Record<string, string>;
  res.status(201).json(await createAnomaly(mapId, systemId, { anomId, anomType, name, notes }, writeActor(req)));
});

apiV1Router.patch('/maps/:mapId/systems/:systemId/anomalies/:anomId', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId, anomId } = req.params;
  await updateAnomaly(mapId, systemId, anomId, req.body as Record<string, unknown>, writeActor(req));
  res.json({ ok: true });
});

apiV1Router.delete('/maps/:mapId/systems/:systemId/anomalies/:anomId', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId, anomId } = req.params;
  await deleteAnomaly(mapId, systemId, anomId, writeActor(req));
  res.json({ ok: true });
});

// Structures
apiV1Router.post('/maps/:mapId/systems/:systemId/structures', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId } = req.params;
  const { name = '', structureType = 'unknown', ownerCorp = '', notes = '', eveId = null } = req.body as Record<string, string>;
  const eveIdNum = eveId ? Number(eveId) : null;
  const ownerCorpId = eveIdNum ? await resolveStructureOwnerCorp(authUser(req).userId, eveIdNum) : null;
  res.status(201).json(await createStructure(mapId, systemId,
    { name, structureType, ownerCorp, notes, eveId: eveIdNum, ownerCorpId }, writeActor(req)));
});

apiV1Router.patch('/maps/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId, structureId } = req.params;
  await updateStructure(mapId, systemId, structureId, req.body as Record<string, unknown>, writeActor(req));
  res.json({ ok: true });
});

apiV1Router.delete('/maps/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  if (!(await writeScope(req, res))) return;
  const { mapId, systemId, structureId } = req.params;
  await deleteStructure(mapId, systemId, structureId, writeActor(req));
  res.json({ ok: true });
});
