import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getValidToken } from '../utils/eveToken.js';
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/cache.js';
import { resolveEntityNames } from '../services/entityNames.js';

export const characterRouter = Router();
characterRouter.use(requireAuth);
const log = createLogger('character');

// userId → last recorded eve system id — used to detect jumps
const lastSeenSystem = new Map<number, number>();

// ESI's `/characters/{id}/online/` is notoriously stale on log-out — the
// `online` flag often keeps returning true for many minutes (sometimes
// hours) after the character actually logged off. Cross-checking against
// `last_login` vs `last_logout` catches that case: those timestamps update
// immediately on transition, while `online` lags behind CCP's cache.
//
// Rule: a character is only really online when ESI says they are AND their
// last_login is at or after their last_logout. Any other shape → offline.
interface EsiOnlineResponse {
  online?:      boolean;
  last_login?:  string;
  last_logout?: string;
  logins?:      number;
}
function isReallyOnline(data: EsiOnlineResponse): boolean {
  if (!data?.online) return false;
  // If either timestamp is missing we trust `online` as-is — the cross-
  // check only catches the specific "online=true but logged out more
  // recently" staleness pattern.
  if (!data.last_login || !data.last_logout) return true;
  const login  = new Date(data.last_login).getTime();
  const logout = new Date(data.last_logout).getTime();
  if (!Number.isFinite(login) || !Number.isFinite(logout)) return true;
  return login >= logout;
}

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
    const onlineData = await onlineRes.json() as EsiOnlineResponse;
    if (!isReallyOnline(onlineData)) {
      lastSeenSystem.delete(req.session.userId!);
      res.json({ online: false }); return;
    }

    // Fetch current location + ship in parallel — both gated on the same
    // token and online check, no point serialising them.
    const [locRes, shipRes] = await Promise.all([
      fetch(`https://esi.evetech.net/latest/characters/${characterId}/location/`,
        { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`https://esi.evetech.net/latest/characters/${characterId}/ship/`,
        { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (!locRes.ok) { res.json({ online: true, system: null, ship: null }); return; }

    const loc = await locRes.json() as { solar_system_id: number };

    // Ship is best-effort — a transient ESI hiccup on /ship/ shouldn't
    // hide the rest of the location payload. Look up the type name from
    // the SDE-seeded item_types so the client gets a ready-to-render label.
    let ship: { typeId: number; typeName: string; shipName: string; mass: number | null } | null = null;
    if (shipRes.ok) {
      const shipData = await shipRes.json() as { ship_type_id: number; ship_name: string };
      const { rows: typeRows } = await db.query<{ name: string; mass: string | null }>(
        `SELECT name, mass FROM item_types WHERE id = $1`,
        [shipData.ship_type_id],
      );
      // item_types.mass is NUMERIC (parsed back as string by node-pg). Cast to
      // number for the wire; null when the SDE row is missing or massless
      // (capsule has 32k kg, so it'll have a value).
      const massRaw = typeRows[0]?.mass;
      const massNum = massRaw == null ? null : Number(massRaw);
      ship = {
        typeId:   shipData.ship_type_id,
        typeName: typeRows[0]?.name ?? `Type ${shipData.ship_type_id}`,
        shipName: shipData.ship_name,
        mass:     massNum != null && Number.isFinite(massNum) ? massNum : null,
      };
    }

    // Record a jump when the system changes
    const userId  = req.session.userId!;
    const prevSys = lastSeenSystem.get(userId);
    if (prevSys !== undefined && prevSys !== loc.solar_system_id) {
      db.query(
        `INSERT INTO user_events (user_id, event_type) VALUES ($1, 'jump')`,
        [userId],
      ).catch(console.error);
    }
    // Persist the last known system to the user profile whenever it's new or
    // changed (first poll of the session, or after a jump). Steady-state polls
    // in the same system don't write. Best-effort — never blocks the response.
    if (prevSys !== loc.solar_system_id) {
      db.query(
        `UPDATE users SET last_known_system_id = $1, last_known_system_at = NOW() WHERE id = $2`,
        [loc.solar_system_id, userId],
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

    if (!rows.length) { res.json({ online: true, system: null, ship }); return; }
    res.json({ online: true, system: rows[0], ship });
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

    const data = await esiRes.json() as EsiOnlineResponse;
    const resolved = isReallyOnline(data);
    // Diagnostic log when ESI claims online — lets us catch the
    // stale-true case in the wild. The raw timestamps are right there to
    // verify whether the cross-check should have caught it. Drop once
    // we're confident the helper is correct.
    if (data?.online) {
      log.info(`online check char=${characterId} esi.online=${data.online} last_login=${data.last_login ?? '-'} last_logout=${data.last_logout ?? '-'} resolved=${resolved}`);
    }
    // Pass `lastLogin` through to the client so the toolbar can show a
    // session-start timestamp in its tooltip. Useful for spotting orphan
    // TQ sessions ("online since 4 hours ago even though I logged out").
    res.json({ online: resolved, lastLogin: data?.last_login ?? null });
  } catch (err) {
    log.error('Online check failed:', err);
    res.status(500).json({ error: 'Failed to check online status' });
  }
});

// ── Fleet ─────────────────────────────────────────────────────────────────

interface FleetMember {
  character_id:    number;
  character_name?: string;
  solar_system_id: number;
}

// Cache of /fleets/{id}/members keyed by fleet_id.
//
// ESI's /fleets/{id}/members endpoint is fleet-boss-only. Wing/squad
// commanders and regular members get 403. So in a fleet where only the
// boss is using Nexum, the boss's poll populates this cache and every
// other fleet member's request reads from it — even though their own
// ESI call would have been rejected.
//
// TTL is short (matches ESI's cache header) but stale entries are kept
// around longer via .peek() so non-boss members still see fleet positions
// between the boss's polls.
// FRESH = "trust without re-fetching". STALE = "still usable when a
// re-fetch isn't an option". Constructor TTL is set to STALE so the
// cache's built-in 2×TTL sweep keeps entries around long enough for
// non-boss members to read them; freshness within that window is
// decided manually via fetchedAt below.
const FLEET_FRESH_MS = 5_000;
const FLEET_STALE_MS = 120_000;
const fleetMembersCache = new TtlCache<string, FleetMember[]>(FLEET_STALE_MS, 5 * 60 * 1000);

// GET /api/character/fleet
// Returns the character's current fleet members + their systems if in one.
// Falls back to { inFleet: false, members: [] } when the character isn't
// in a fleet or hasn't granted the esi-fleets.read_fleet.v1 scope.
characterRouter.get('/fleet', async (req, res) => {
  try {
    const { rows: userRows } = await db.query<{ character_id: number }>(
      `SELECT character_id FROM users WHERE id = $1`,
      [req.session.userId],
    );
    if (!userRows.length) { res.status(404).json({ error: 'User not found' }); return; }

    const token       = await getValidToken(req.session.userId!);
    const characterId = userRows[0].character_id;

    // 1) Which fleet (if any) is this character in? ESI returns 404 when
    //    the character isn't in a fleet — that's expected, not an error.
    const fleetRes = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/fleet/`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (fleetRes.status === 404) { res.json({ inFleet: false, members: [] }); return; }
    if (!fleetRes.ok) {
      // 403 = scope not granted or role insufficient; either way, just
      // hand back an empty fleet so the UI degrades silently.
      if (fleetRes.status === 403) { res.json({ inFleet: false, members: [] }); return; }
      log.warn(`fleet lookup failed: ${fleetRes.status}`);
      res.json({ inFleet: false, members: [] }); return;
    }
    const fleetInfo = await fleetRes.json() as { fleet_id: number; role?: string };
    const fleetKey  = String(fleetInfo.fleet_id);
    const isBoss    = fleetInfo.role === 'fleet_commander';

    // 2) Members. Two paths:
    //    - Boss: refresh from ESI when cache is stale, otherwise serve fresh.
    //    - Non-boss: serve whatever's in the cache (fresh or stale), don't
    //      try to refresh — ESI will 403. The boss's polling keeps the
    //      cache warm for everyone.
    let members: FleetMember[] | null = null;
    const entry  = fleetMembersCache.peek(fleetKey);
    const age    = entry ? Date.now() - entry.fetchedAt : Infinity;
    const isFresh = entry !== null && age < FLEET_FRESH_MS;
    const isStale = entry !== null && age < FLEET_STALE_MS;

    if (isFresh && entry) {
      members = entry.value;
    } else if (isBoss) {
      const memRes = await fetch(
        `https://esi.evetech.net/latest/fleets/${fleetInfo.fleet_id}/members/`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (memRes.ok) {
        const raw = await memRes.json() as Array<{ character_id: number; solar_system_id: number }>;
        members = raw.map((m) => ({
          character_id:    m.character_id,
          solar_system_id: m.solar_system_id,
        }));
        fleetMembersCache.set(fleetKey, members);
      } else {
        if (memRes.status !== 403 && memRes.status !== 404) {
          log.warn(`fleet members lookup failed: ${memRes.status}`);
        }
        // ESI hiccup — fall back to stale if we still have it.
        if (isStale && entry) members = entry.value;
      }
    } else if (isStale && entry) {
      // Non-boss path: ride along on whatever the boss most recently cached.
      members = entry.value;
    }
    if (!members) {
      res.json({ inFleet: true, members: [] }); return;
    }

    // 3) Resolve names — entity_names cache makes this effectively free
    //    after the first time we see each member.
    const names = await resolveEntityNames(members.map((m) => m.character_id));
    const enriched = members.map((m) => ({
      ...m,
      character_name: names.get(m.character_id)?.name,
    }));

    res.json({ inFleet: true, members: enriched });
  } catch (err) {
    log.error('Fleet lookup failed:', err);
    res.status(500).json({ error: 'Failed to get fleet' });
  }
});
