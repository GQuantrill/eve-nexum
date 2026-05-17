import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { refreshCorpStructures } from '../services/corpStructures.js';
import { importFromUrl } from '../services/publicStructures.js';

export const knownStructuresRouter = Router();
knownStructuresRouter.use(requireAuth);

// GET /api/known-structures/:eveSystemId — every cached structure in that
// solar system that the caller is allowed to see. Corp-ESI rows are
// scoped to their corp via `restricted_to_corp_id`; public-dataset rows
// are visible to everyone.
knownStructuresRouter.get('/:eveSystemId(\\d+)', async (req, res) => {
  const systemId  = parseInt(req.params.eveSystemId, 10);
  const userCorp  = req.session.userCorpId ?? null;
  const { rows } = await db.query<{
    structureId:  string;
    systemId:     number;
    ownerCorpId:  number | null;
    name:         string;
    typeId:       number | null;
    source:       string;
    lastSeenAt:   string;
  }>(
    `SELECT structure_id  AS "structureId",
            system_id     AS "systemId",
            owner_corp_id AS "ownerCorpId",
            name,
            type_id       AS "typeId",
            source,
            last_seen_at  AS "lastSeenAt"
     FROM known_structures
     WHERE system_id = $1
       AND (restricted_to_corp_id IS NULL OR restricted_to_corp_id = $2)
     ORDER BY name`,
    [systemId, userCorp],
  );
  res.json(rows);
});

// POST /api/known-structures/refresh-corp — admin-only force-refresh of
// the corp-ESI puller for the caller's corp. Used by the admin UI's
// debugging tools.
knownStructuresRouter.post('/refresh-corp', requireAdmin, async (req, res) => {
  const corpId = req.session.userCorpId;
  if (!corpId) { res.status(400).json({ error: 'caller has no corp affiliation' }); return; }
  const result = await refreshCorpStructures(corpId, { force: true });
  res.json(result);
});

// POST /api/known-structures/import-public — admin-only manual trigger
// for the public-dataset import. URL comes from the body so an admin can
// experiment with different sources without bouncing the server.
knownStructuresRouter.post('/import-public', requireAdmin, async (req, res) => {
  const url = typeof (req.body as { url?: string }).url === 'string'
    ? (req.body as { url: string }).url
    : process.env.PUBLIC_STRUCTURES_URL;
  if (!url) { res.status(400).json({ error: 'no url supplied and PUBLIC_STRUCTURES_URL unset' }); return; }
  const result = await importFromUrl(url);
  res.json(result);
});
