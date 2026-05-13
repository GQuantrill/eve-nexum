import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getValidToken } from '../utils/eveToken.js';
import { createLogger } from '../utils/logger.js';

export const characterRouter = Router();
characterRouter.use(requireAuth);
const log = createLogger('character');

// userId → last recorded eve system id — used to detect jumps
const lastSeenSystem = new Map<number, number>();

// GET /api/character/location
// Returns the character's current system if online, or { online: false }
characterRouter.get('/location', async (req, res) => {
  try {
    const { rows: userRows } = await db.query<{ character_id: number }>(
      `SELECT character_id FROM users WHERE id = $1`,
      [req.session.userId],
    );
    if (!userRows.length) { res.status(404).json({ error: 'User not found' }); return; }

    const token       = await getValidToken(req.session.userId!);
    const characterId = userRows[0].character_id;

    // Check online status first
    const onlineRes = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/online/`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!onlineRes.ok || onlineRes.status === 401 || onlineRes.status === 403) {
      res.json({ online: false }); return;
    }
    const { online } = await onlineRes.json() as { online: boolean };
    if (!online) {
      lastSeenSystem.delete(req.session.userId!);
      res.json({ online: false }); return;
    }

    // Fetch current location
    const locRes = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/location/`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!locRes.ok) { res.json({ online: true, system: null }); return; }

    const loc = await locRes.json() as { solar_system_id: number };

    // Record a jump when the system changes
    const userId  = req.session.userId!;
    const prevSys = lastSeenSystem.get(userId);
    if (prevSys !== undefined && prevSys !== loc.solar_system_id) {
      db.query(
        `INSERT INTO user_events (user_id, event_type) VALUES ($1, 'jump')`,
        [userId],
      ).catch(console.error);
    }
    lastSeenSystem.set(userId, loc.solar_system_id);

    // Look up system details in our DB
    const { rows } = await db.query(
      `SELECT s.id AS "eveSystemId", s.name, s.class AS "systemClass",
              COALESCE(s.effect, 'none') AS effect, s.statics,
              r.name AS "regionName", r.npc_type AS "npcType"
       FROM solar_systems s
       LEFT JOIN map_regions r ON r.id = s.region_id
       WHERE s.id = $1`,
      [loc.solar_system_id],
    );

    if (!rows.length) { res.json({ online: true, system: null }); return; }
    res.json({ online: true, system: rows[0] });
  } catch (err) {
    log.error('Location check failed:', err);
    res.status(500).json({ error: 'Failed to get location' });
  }
});

// POST /api/character/waypoint
characterRouter.post('/waypoint', async (req, res) => {
  const { destinationId, addToBeginning = false, clearOtherWaypoints = false } =
    req.body as { destinationId?: unknown; addToBeginning?: boolean; clearOtherWaypoints?: boolean };

  // EVE destination IDs are positive 32-bit integers (solar systems, stations,
  // structures). Coerce + range-check to keep arbitrary strings out of the ESI
  // URL.
  const destNum = typeof destinationId === 'number' ? destinationId : Number(destinationId);
  if (!Number.isInteger(destNum) || destNum <= 0 || destNum > 2_147_483_647) {
    res.status(400).json({ error: 'destinationId must be a positive integer' });
    return;
  }

  const { rows } = await db.query<{ character_id: number }>(
    `SELECT character_id FROM users WHERE id = $1`,
    [req.session.userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }

  try {
    const token  = await getValidToken(req.session.userId!);
    const params = new URLSearchParams({
      add_to_beginning:     String(addToBeginning),
      clear_other_waypoints: String(clearOtherWaypoints),
      destination_id:       String(destNum),
    });
    const esiRes = await fetch(
      `https://esi.evetech.net/latest/ui/autopilot/waypoint/?${params}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!esiRes.ok) { res.status(502).json({ error: `ESI returned ${esiRes.status}` }); return; }
    res.json({ ok: true });
  } catch (err) {
    log.error('Waypoint set failed:', err);
    res.status(500).json({ error: 'Failed to set waypoint' });
  }
});

// GET /api/character/online
characterRouter.get('/online', async (req, res) => {
  try {
    const { rows } = await db.query<{ character_id: number }>(
      `SELECT character_id FROM users WHERE id = $1`,
      [req.session.userId],
    );
    if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }

    const token = await getValidToken(req.session.userId!);
    const characterId = rows[0].character_id;

    const esiRes = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/online/`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // 401 = token invalid/no scopes, 403 = token valid but scope missing
    if (esiRes.status === 401 || esiRes.status === 403) {
      res.json({ online: null, scopeMissing: true });
      return;
    }

    if (!esiRes.ok) {
      const body = await esiRes.text();
      log.error(`ESI online check: ${esiRes.status}`, body);
      res.status(502).json({ error: `ESI returned ${esiRes.status}` });
      return;
    }

    const data = await esiRes.json() as { online: boolean; last_login?: string; last_logout?: string };
    res.json({ online: data.online });
  } catch (err) {
    log.error('Online check failed:', err);
    res.status(500).json({ error: 'Failed to check online status' });
  }
});
