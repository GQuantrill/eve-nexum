import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';

const router = Router();

function requireCorpMember(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  if (!req.session.userId || !req.session.userCorpId) {
    res.status(401).json({ error: 'Not authenticated or not in a corp' });
    return;
  }
  next();
}

router.use(requireCorpMember);

router.get('/', async (req, res) => {
  const corpId = req.session.userCorpId!;
  const useShared = config.corpMapShared && config.corpIds.length > 1;

  const { rows } = await db.query(
    `SELECT cs.structure_id, cs.corporation_id, cs.system_id, cs.type_id,
            cs.name, cs.state, cs.fuel_expires, cs.services,
            cs.reinforce_hour, cs.state_timer_start, cs.state_timer_end,
            cs.unanchors_at, cs.last_polled,
            it.name AS type_name,
            ss.name AS system_name
     FROM corp_structures cs
     LEFT JOIN item_types it ON it.eve_type_id = cs.type_id
     LEFT JOIN solar_systems ss ON ss.eve_system_id = cs.system_id
     WHERE cs.removed_at IS NULL
       AND ${useShared ? 'cs.corporation_id = ANY($1)' : 'cs.corporation_id = $1'}
     ORDER BY cs.fuel_expires ASC NULLS LAST`,
    [useShared ? config.corpIds : corpId],
  );

  res.json(rows);
});

router.get('/by-system/:eveSystemId', async (req, res) => {
  const corpId = req.session.userCorpId!;
  const eveSystemId = parseInt(req.params.eveSystemId, 10);
  if (!Number.isInteger(eveSystemId)) {
    res.status(400).json({ error: 'Invalid system ID' });
    return;
  }

  const useShared = config.corpMapShared && config.corpIds.length > 1;

  const { rows } = await db.query(
    `SELECT cs.structure_id, cs.corporation_id, cs.system_id, cs.type_id,
            cs.name, cs.state, cs.fuel_expires, cs.services,
            cs.reinforce_hour, cs.state_timer_start, cs.state_timer_end,
            cs.unanchors_at, cs.last_polled,
            it.name AS type_name
     FROM corp_structures cs
     LEFT JOIN item_types it ON it.eve_type_id = cs.type_id
     WHERE cs.removed_at IS NULL
       AND cs.system_id = $1
       AND ${useShared ? 'cs.corporation_id = ANY($2)' : 'cs.corporation_id = $2'}`,
    [eveSystemId, useShared ? config.corpIds : corpId],
  );

  res.json(rows);
});

export default router;
