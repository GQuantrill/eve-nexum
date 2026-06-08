import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { encryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';
import { esiFetch } from '../utils/esi.js';
import { refreshStandingsForUser } from '../services/standings.js';
import { seedDemoMap } from '../services/demoMap.js';

const log = createLogger('auth');

export const authRouter = Router();

const CLIENT_ID     = process.env.EVE_CLIENT_ID!;
const CLIENT_SECRET = process.env.EVE_CLIENT_SECRET!;
const CALLBACK_URL  = process.env.EVE_CALLBACK_URL ?? 'http://localhost:3001/auth/callback';
const FRONTEND_URL  = process.env.FRONTEND_URL ?? 'http://localhost:5174';

const EVE_AUTH_URL  = 'https://login.eveonline.com/v2/oauth/authorize';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';

const SSO_SCOPES = [
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-universe.read_structures.v1',
  'esi-corporations.read_corporation_membership.v1',
  'esi-ui.open_window.v1',
  'esi-ui.write_waypoint.v1',
  'esi-characters.read_corporation_roles.v1',
  'esi-location.read_online.v1',
  // Read player standings (contacts) so the UI can colour-tag structures /
  // killboard / sov by your standing toward each entity. Corp / alliance reads
  // only succeed for characters with the Contact Manager role; reads gracefully
  // no-op otherwise.
  'esi-characters.read_contacts.v1',
  'esi-corporations.read_contacts.v1',
  'esi-alliances.read_contacts.v1',
  // Fleet member tracking — show fleet-mate locations on the map as purple
  // dots. Requires the character to be the fleet boss or a wing/squad
  // commander; ESI returns 403 to everyone else and the UI degrades silently.
  'esi-fleets.read_fleet.v1',
].join(' ');

// Build the SSO authorize redirect with a fresh CSRF state and send the user.
function beginSso(req: Request, res: Response): void {
  const state = randomBytes(32).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  CALLBACK_URL,
    client_id:     CLIENT_ID,
    scope:         SSO_SCOPES,
    state,
  });
  req.session.save((err) => {
    if (err) { res.status(500).json({ error: 'Session error' }); return; }
    res.redirect(`${EVE_AUTH_URL}?${params}`);
  });
}

// Resolve the session's owner (account) id, lazily backfilling it from the DB
// for sessions created before multi-account support shipped.
async function ensureOwnerId(req: Request): Promise<number | null> {
  if (req.session.ownerId != null) return req.session.ownerId;
  if (!req.session.userId) return null;
  const { rows } = await db.query<{ owner_id: number | null }>(
    `SELECT owner_id FROM users WHERE id = $1`, [req.session.userId],
  );
  const oid = rows[0]?.owner_id ?? null;
  if (oid != null) req.session.ownerId = oid;
  return oid;
}

// GET /auth/login  — redirect to EVE SSO for a fresh login
authRouter.get('/login', (req, res) => {
  // A normal login must never carry an add-character link from a stale session.
  delete req.session.addCharacterOwnerId;
  beginSso(req, res);
});

// GET /auth/add-character — link another character to the current account.
// Only an authenticated session may do this; the callback reads
// addCharacterOwnerId to attach the returning character to this owner.
authRouter.get('/add-character', async (req, res) => {
  const ownerId = await ensureOwnerId(req);
  if (!req.session.userId || ownerId == null) {
    res.redirect(`${FRONTEND_URL}?error=not_authenticated`);
    return;
  }
  req.session.addCharacterOwnerId = ownerId;
  beginSso(req, res);
});

// GET /auth/callback  — EVE SSO returns here
authRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query as Record<string, string>;

  const expectedState = req.session.oauthState;
  if (!code || !state || !expectedState || state !== expectedState) {
    res.status(400).json({ error: 'Invalid OAuth state' });
    return;
  }
  delete req.session.oauthState;
  // Captured before any session.regenerate(): if set, this SSO round-trip is
  // an authenticated "add character" link, not a fresh login.
  const addCharacterOwnerId = req.session.addCharacterOwnerId;
  delete req.session.addCharacterOwnerId;

  // Failure redirect target. For an add-character attempt the pilot is still
  // logged in (as their active character), so they land on the app, not the
  // landing page — use ?link_error= so the app can toast the reason. A fresh
  // login uses ?error= which the landing page renders inline.
  const failUrl = (code: string) =>
    `${FRONTEND_URL}?${addCharacterOwnerId != null ? 'link_error' : 'error'}=${code}`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(EVE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: CALLBACK_URL,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      log.error('Token exchange failed:', err);
      res.status(502).json({ error: 'Token exchange failed' });
      return;
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Decode the JWT payload to extract character info (EVE SSO v2)
    const jwtPayload = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; name: string };

    // sub format: "CHARACTER:EVE:12345678"
    const characterId = parseInt(jwtPayload.sub.split(':')[2], 10);
    if (!characterId) {
      res.status(502).json({ error: 'Could not parse character ID from token' });
      return;
    }

    // Pull the character's corp + alliance from public ESI so we know
    // which corp/alliance to scope standings refreshes to. This used to
    // only run in corp mode; we now always do it so personal standings
    // also have an alliance bucket to target.
    let userCorpId: number | null = null;
    let userAllianceId: number | null = null;
    try {
      const esiChar = await esiFetch(`https://esi.evetech.net/v4/characters/${characterId}/`);
      if (!esiChar.ok) {
        if (config.corpMode) {
          res.redirect(failUrl('corp_check_failed'));
          return;
        }
        // Solo mode: ESI hiccup shouldn't block login.
        log.error(`ESI character lookup failed: ${esiChar.status}`);
      } else {
        const charData = await esiChar.json() as { corporation_id: number; alliance_id?: number };
        userCorpId     = charData.corporation_id;
        userAllianceId = charData.alliance_id ?? null;
        if (config.corpMode && !config.corpIds.includes(userCorpId)) {
          res.redirect(failUrl('not_in_corp'));
          return;
        }
      }
    } catch {
      if (config.corpMode) {
        res.redirect(failUrl('corp_check_failed'));
        return;
      }
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Role policy:
    //   - Solo mode (no CORP_ID set): no admin tooling matters because there
    //     are no other users to manage. Default everyone to 'admin' and
    //     force-upgrade existing rows on every login — otherwise users that
    //     signed up while corp mode was on stay stuck at readonly.
    //   - Corp mode: ADMIN_CHAR_ID is always pinned to admin; other new
    //     users default to readonly so an admin has to promote them.
    const isAdminChar = characterId === config.adminCharId;
    const defaultRole = (!config.corpMode || isAdminChar) ? 'admin' : 'readonly';

    const { rows } = await db.query<{ id: number; role: string; blocked: boolean }>(
      `INSERT INTO users (character_id, character_name, access_token, refresh_token, token_expires_at, role, corp_id, alliance_id, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $8, $10, NOW())
       ON CONFLICT (character_id) DO UPDATE SET
         character_name   = EXCLUDED.character_name,
         access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         last_login_at    = NOW(),
         corp_id          = COALESCE($8::int,  users.corp_id),
         alliance_id      = COALESCE($10::int, users.alliance_id),
         role             = CASE
           -- ADMIN_CHAR_ID is always pinned to admin regardless of mode
           WHEN $7::int IS NOT NULL AND users.character_id = $7::int THEN 'admin'
           -- Solo mode: everyone is admin (roles are meaningless without corp scope)
           WHEN $9::bool THEN 'admin'
           ELSE users.role
         END,
         updated_at       = NOW()
       RETURNING id, role, blocked`,
      [characterId, jwtPayload.name, encryptToken(tokens.access_token), encryptToken(tokens.refresh_token), expiresAt,
       defaultRole, config.adminCharId, userCorpId, !config.corpMode, userAllianceId],
    );

    const userId = rows[0].id;
    const role   = rows[0].role as 'admin' | 'full' | 'edit' | 'readonly';

    // Blocked users can never sign in. ADMIN_CHAR_ID is the safety hatch:
    // it can't be blocked by the role/block flow, but if the DB row somehow
    // ends up flagged we still let the configured admin character through.
    if (rows[0].blocked && characterId !== config.adminCharId) {
      res.redirect(failUrl('blocked'));
      return;
    }

    // Fire-and-forget standings refresh. Raw access token (not the
    // encrypted-at-rest version) since it's already in memory; the service
    // swallows its own errors so a bad ESI response never breaks the flow.
    const kickStandings = () => refreshStandingsForUser({
      userId, characterId, corpId: userCorpId, allianceId: userAllianceId,
      accessToken: tokens.access_token,
    }).catch((err) => log.error('standings refresh kickoff failed:', err));

    // ── Add-character link ────────────────────────────────────────────────
    // Authenticated "add character" flow: attach this character to the
    // initiating account and return WITHOUT touching the active session — no
    // regenerate, no active-character change. The character's maps follow it
    // onto the owner (merge); the per-owner map cap is enforced at creation
    // time (phase 3) so nothing is deleted here.
    if (addCharacterOwnerId != null) {
      if (!req.session.userId) { res.redirect(failUrl('not_authenticated')); return; }
      await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [addCharacterOwnerId, userId]);
      await db.query(`UPDATE maps  SET owner_id = $1 WHERE user_id = $2`, [addCharacterOwnerId, userId]);
      req.session.ownerId = addCharacterOwnerId;
      await new Promise<void>((resolve, reject) => { req.session.save((err) => err ? reject(err) : resolve()); });
      kickStandings();
      res.redirect(`${FRONTEND_URL}?added=${encodeURIComponent(jwtPayload.name)}`);
      return;
    }

    // ── Fresh login ───────────────────────────────────────────────────────
    // Ensure the character has an owner: the one backfilled in phase 1, or a
    // brand-new account for a first-ever login.
    const { rows: ownerRows } = await db.query<{ owner_id: number | null }>(
      `SELECT owner_id FROM users WHERE id = $1`, [userId]);
    let ownerId = ownerRows[0]?.owner_id ?? null;
    if (ownerId == null) {
      const { rows: created } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
      ownerId = created[0].id;
      await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [ownerId, userId]);
      await db.query(`UPDATE maps SET owner_id = $1 WHERE user_id = $2 AND owner_id IS NULL`, [ownerId, userId]);
    }

    // First login: seed a starter "Demo Map" so the canvas isn't blank.
    // No-op when the user already has a map.
    await seedDemoMap(userId);

    // Snapshot prefs into the session so /auth/me can answer without a DB call.
    const prefRows = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; uniform_size: boolean; show_statics: boolean; connection_thickness: string; route_mode: string; ui_zoom: string; ui_settings: Record<string, unknown>; panel_order: string[] }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics, connection_thickness, route_mode, ui_zoom, ui_settings, panel_order FROM users WHERE id = $1`,
      [userId],
    );
    const p = prefRows.rows[0];

    // Regenerate to a fresh session ID before assigning credentials — defends
    // against session fixation (a pre-login session ID lingering post-auth).
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => err ? reject(err) : resolve());
    });

    req.session.userId        = userId;
    req.session.characterId   = characterId;
    req.session.characterName = jwtPayload.name;
    req.session.role          = role;
    req.session.userCorpId    = userCorpId;
    req.session.ownerId       = ownerId;
    req.session.prefs         = {
      compactMode: p?.compact_mode ?? false,
      snapToGrid:  p?.snap_to_grid ?? false,
      showMinimap: p?.show_minimap ?? true,
      uniformSize: p?.uniform_size ?? true,
      showStatics: p?.show_statics ?? true,
      connectionThickness: p?.connection_thickness ?? 'standard',
      routeMode:   p?.route_mode ?? 'shortest',
      uiZoom:      p?.ui_zoom != null ? Number(p.ui_zoom) : 1,
      uiSettings:  p?.ui_settings ?? {},
      panelOrder:  p?.panel_order  ?? ['notes', 'signatures'],
    };

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => err ? reject(err) : resolve());
    });

    kickStandings();
    // ?login=success lets the frontend fire a one-time analytics "login" event
    // (it's only present on the post-callback redirect, not on normal loads).
    res.redirect(`${FRONTEND_URL}?login=success`);
  } catch (err) {
    log.error('Auth callback error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /auth/logout
authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// POST /auth/switch-character — make another character on the same account the
// active one. No SSO: the target's tokens are already stored from when it was
// added. Authorised strictly by owner ownership.
authRouter.post('/switch-character', async (req, res) => {
  const ownerId = await ensureOwnerId(req);
  if (!req.session.userId || ownerId == null) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const targetId = Number((req.body as { userId?: unknown }).userId);
  if (!Number.isInteger(targetId)) { res.status(400).json({ error: 'Invalid userId' }); return; }

  const { rows } = await db.query<{
    owner_id: number | null; character_id: number; character_name: string; role: string;
    corp_id: number | null; blocked: boolean;
    compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; uniform_size: boolean;
    show_statics: boolean; connection_thickness: string; route_mode: string; ui_zoom: string;
    ui_settings: Record<string, unknown>; panel_order: string[];
  }>(
    `SELECT owner_id, character_id, character_name, role, corp_id, blocked,
            compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics,
            connection_thickness, route_mode, ui_zoom, ui_settings, panel_order
     FROM users WHERE id = $1`,
    [targetId],
  );
  const u = rows[0];
  // Must belong to the same account, and you can't switch into a blocked char.
  if (!u || u.owner_id !== ownerId) { res.status(403).json({ error: 'Not your character' }); return; }
  if (u.blocked && u.character_id !== config.adminCharId) { res.status(403).json({ error: 'Character is blocked' }); return; }

  req.session.userId        = targetId;
  req.session.characterId   = u.character_id;
  req.session.characterName = u.character_name;
  req.session.role          = u.role as 'admin' | 'full' | 'edit' | 'readonly';
  req.session.userCorpId    = u.corp_id;
  req.session.prefs         = {
    compactMode: u.compact_mode ?? false,
    snapToGrid:  u.snap_to_grid ?? false,
    showMinimap: u.show_minimap ?? true,
    uniformSize: u.uniform_size ?? true,
    showStatics: u.show_statics ?? true,
    connectionThickness: u.connection_thickness ?? 'standard',
    routeMode:   u.route_mode ?? 'shortest',
    uiZoom:      u.ui_zoom != null ? Number(u.ui_zoom) : 1,
    uiSettings:  u.ui_settings ?? {},
    panelOrder:  u.panel_order  ?? ['notes', 'signatures'],
  };
  await new Promise<void>((resolve, reject) => { req.session.save((err) => err ? reject(err) : resolve()); });
  res.json({ ok: true });
});

// POST /auth/remove-character — unlink a character from the current account.
// Detaches by clearing owner_id: the character keeps its own data and, on a
// later fresh login, becomes its own standalone account again. Maps already
// merged onto the account stay with it (a merge is one-way). You cannot remove
// the currently-active character — switch away first — which also guarantees an
// account can never strip out its last remaining character.
authRouter.post('/remove-character', async (req, res) => {
  const ownerId = await ensureOwnerId(req);
  if (!req.session.userId || ownerId == null) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const targetId = Number((req.body as { userId?: unknown }).userId);
  if (!Number.isInteger(targetId)) { res.status(400).json({ error: 'Invalid userId' }); return; }
  if (targetId === req.session.userId) { res.status(400).json({ error: 'Cannot remove the active character' }); return; }

  // Scope the UPDATE to this owner so you can only ever detach your own alts.
  const { rowCount } = await db.query(
    `UPDATE users SET owner_id = NULL WHERE id = $1 AND owner_id = $2`,
    [targetId, ownerId],
  );
  if (!rowCount) { res.status(403).json({ error: 'Not your character' }); return; }
  res.json({ ok: true });
});

// GET /auth/me
authRouter.get('/me', async (req, res) => {
  if (!req.session.userId) {
    res.json({ user: null });
    return;
  }

  // Hot path: prefs cached in session by login / PATCH. Only fall back to the
  // DB for pre-existing sessions that predate this caching change.
  let prefs = req.session.prefs;
  let role  = req.session.role ?? 'readonly';
  if (!prefs) {
    const { rows } = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; uniform_size: boolean; show_statics: boolean; connection_thickness: string; route_mode: string; ui_zoom: string; ui_settings: Record<string, unknown>; panel_order: string[]; role: string }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics, connection_thickness, route_mode, ui_zoom, ui_settings, panel_order, role FROM users WHERE id = $1`,
      [req.session.userId],
    );
    const row = rows[0];
    prefs = {
      compactMode: row?.compact_mode ?? false,
      snapToGrid:  row?.snap_to_grid ?? false,
      showMinimap: row?.show_minimap ?? true,
      uniformSize: row?.uniform_size ?? true,
      showStatics: row?.show_statics ?? true,
      connectionThickness: row?.connection_thickness ?? 'standard',
      routeMode:   row?.route_mode ?? 'shortest',
      uiZoom:      row?.ui_zoom != null ? Number(row.ui_zoom) : 1,
      uiSettings:  row?.ui_settings ?? {},
      panelOrder:  row?.panel_order  ?? ['notes', 'signatures'],
    };
    role = (row?.role as 'admin' | 'full' | 'edit' | 'readonly') ?? 'readonly';
    req.session.prefs = prefs;
    req.session.role  = role;
  }

  // Last known system is dynamic (updated as the pilot jumps), so it's read
  // fresh from the DB rather than the session prefs cache. Joined to
  // solar_systems for a ready-to-render name + class.
  const { rows: lksRows } = await db.query<{ id: number | null; name: string | null; systemClass: string | null; at: string | null }>(
    `SELECT u.last_known_system_id AS id, s.name, s.class AS "systemClass", u.last_known_system_at AS at
     FROM users u LEFT JOIN solar_systems s ON s.id = u.last_known_system_id
     WHERE u.id = $1`,
    [req.session.userId],
  );
  const lk = lksRows[0];
  // Number() guards against node-pg returning the id as a string (it does for
  // BIGINT columns) — the client compares it numerically against map system ids.
  const lastKnownSystem = lk?.id != null
    ? { id: Number(lk.id), name: lk.name, systemClass: lk.systemClass, at: lk.at }
    : null;

  // All characters linked to this account, for the character switcher.
  const ownerId = await ensureOwnerId(req);
  const { rows: charRows } = ownerId != null
    ? await db.query<{ id: number; characterId: number; characterName: string; role: string; corpId: number | null; blocked: boolean; lksId: number | null; lksName: string | null; lksClass: string | null }>(
        `SELECT u.id, u.character_id AS "characterId", u.character_name AS "characterName", u.role,
                u.corp_id AS "corpId", u.blocked,
                u.last_known_system_id AS "lksId", s.name AS "lksName", s.class AS "lksClass"
         FROM users u LEFT JOIN solar_systems s ON s.id = u.last_known_system_id
         WHERE u.owner_id = $1 ORDER BY u.character_name`,
        [ownerId])
    : { rows: [] };
  const characters = charRows.map((c) => ({
    id:                  c.id,
    characterId:         c.characterId,
    characterName:       c.characterName,
    role:                c.role,
    corpId:              c.corpId,
    blocked:             c.blocked,
    lastKnownSystemId:   c.lksId != null ? Number(c.lksId) : null,
    lastKnownSystemName: c.lksName,
    lastKnownSystemClass: c.lksClass,
    active:              c.id === req.session.userId,
  }));

  res.json({
    user: {
      id:            req.session.userId,
      characterId:   req.session.characterId,
      characterName: req.session.characterName,
      role,
      ownerId,
      characters,
      lastKnownSystem,
      corpMode:      config.corpMode,
      compactMode:   prefs.compactMode,
      snapToGrid:    prefs.snapToGrid,
      showMinimap:   prefs.showMinimap,
      uniformSize:   prefs.uniformSize ?? true,
      // Default to true for sessions that predate this field — the cached
      // prefs object on disk doesn't carry it, so the literal value would
      // be undefined and the UI would mistakenly read it as "off".
      showStatics:   prefs.showStatics ?? true,
      connectionThickness: prefs.connectionThickness ?? 'standard',
      routeMode:     prefs.routeMode ?? 'shortest',
      uiZoom:        prefs.uiZoom ?? 1,
      uiSettings:    prefs.uiSettings ?? {},
      panelOrder:    prefs.panelOrder,
      canViewReports: config.reportsCharId !== null && req.session.characterId === config.reportsCharId,
    },
  });
});

// PATCH /auth/preferences
const MAX_PANELS = 16;
const MAX_PANEL_KEY_LEN = 64;

authRouter.patch('/preferences', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { compactMode, snapToGrid, showMinimap, uniformSize, showStatics, connectionThickness, routeMode, uiZoom, panelOrder } = req.body as { compactMode?: boolean; snapToGrid?: boolean; showMinimap?: boolean; uniformSize?: boolean; showStatics?: boolean; connectionThickness?: string; routeMode?: string; uiZoom?: number; panelOrder?: unknown };
  const VALID_THICKNESS = new Set(['thin', 'standard', 'thick', 'extra']);
  const VALID_ROUTE_MODE = new Set(['shortest', 'secure']);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof compactMode === 'boolean') { sets.push(`compact_mode = $${vals.length + 1}`); vals.push(compactMode); }
  if (typeof snapToGrid  === 'boolean') { sets.push(`snap_to_grid = $${vals.length + 1}`); vals.push(snapToGrid); }
  if (typeof showMinimap === 'boolean') { sets.push(`show_minimap = $${vals.length + 1}`); vals.push(showMinimap); }
  if (typeof uniformSize === 'boolean') { sets.push(`uniform_size = $${vals.length + 1}`); vals.push(uniformSize); }
  if (typeof showStatics === 'boolean') { sets.push(`show_statics = $${vals.length + 1}`); vals.push(showStatics); }
  if (typeof connectionThickness === 'string' && VALID_THICKNESS.has(connectionThickness)) {
    sets.push(`connection_thickness = $${vals.length + 1}`); vals.push(connectionThickness);
  }
  if (typeof routeMode === 'string' && VALID_ROUTE_MODE.has(routeMode)) {
    sets.push(`route_mode = $${vals.length + 1}`); vals.push(routeMode);
  }
  if (typeof uiZoom === 'number' && Number.isFinite(uiZoom)) {
    const clamped = Math.min(1.5, Math.max(0.8, uiZoom));
    sets.push(`ui_zoom = $${vals.length + 1}`); vals.push(clamped);
  }
  if (panelOrder !== undefined) {
    if (!Array.isArray(panelOrder) || panelOrder.length > MAX_PANELS ||
        !panelOrder.every((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PANEL_KEY_LEN)) {
      res.status(400).json({ error: 'panelOrder must be an array of short strings' });
      return;
    }
    sets.push(`panel_order = $${vals.length + 1}`); vals.push(panelOrder);
  }
  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length + 1}`,
    [...vals, req.session.userId],
  );

  // Keep the session cache in sync so the next /auth/me reflects the change
  // without going back to the DB.
  if (req.session.prefs) {
    if (typeof compactMode === 'boolean') req.session.prefs.compactMode = compactMode;
    if (typeof snapToGrid  === 'boolean') req.session.prefs.snapToGrid  = snapToGrid;
    if (typeof showMinimap === 'boolean') req.session.prefs.showMinimap = showMinimap;
    if (typeof uniformSize === 'boolean') req.session.prefs.uniformSize = uniformSize;
    if (typeof showStatics === 'boolean') req.session.prefs.showStatics = showStatics;
    if (typeof connectionThickness === 'string' && VALID_THICKNESS.has(connectionThickness)) {
      req.session.prefs.connectionThickness = connectionThickness;
    }
    if (typeof routeMode === 'string' && VALID_ROUTE_MODE.has(routeMode)) {
      req.session.prefs.routeMode = routeMode;
    }
    if (typeof uiZoom === 'number' && Number.isFinite(uiZoom)) {
      req.session.prefs.uiZoom = Math.min(1.5, Math.max(0.8, uiZoom));
    }
    if (Array.isArray(panelOrder))        req.session.prefs.panelOrder  = panelOrder as string[];
  }

  res.json({ ok: true });
});

// PATCH /auth/settings — cross-device UI settings stored as JSONB.
// Body: { entries: { [key]: <any JSON> } }. Each key in entries is
// shallow-merged into users.ui_settings via Postgres' `||` operator,
// so unrelated keys are preserved. Allow-list keeps junk out.
const SETTINGS_ALLOWLIST = new Set<string>([
  'nexum.closestSystems.hiddenHome',
  'nexum.closestSystems.list',
  'nexum.killboardIncludeNpc',
  'nexum.mapSidebar.connections',
  'nexum.mapSidebar.export',
  'nexum.mapSidebar.mapOptions',
  'nexum.mapSidebar.proximity',
  'nexum.mapSidebar.route',
  'nexum.mapSidebar.shortcuts',
  'nexum.mapSidebar.stale',
  'nexum.mapSidebar.systemOptions',
  'nexum.panel.collapsed.a0',
  'nexum.panel.collapsed.closest',
  'nexum.panel.collapsed.notes',
  'nexum.panel.collapsed.signatures',
  'nexum.panel.collapsed.structures',
  'nexum.panel.collapsed.thera',
  'nexum.panel.collapsed.turnur',
  'nexum.proximityThreshold',
  'nexum.customIntel',
  'nexum.crossMapSync',
  'nexum.watchlist',
  'nexum.watchlist.sound',
  'nexum.watchlist.panelOpen',
  'nexum.sig.bookmarkFormat',
  'nexum.sigPane.overwriteOnPaste',
  'nexum.sigPane.overwriteDelay',
  'nexum.anomPane.overwriteOnPaste',
  'nexum.anomPane.overwriteDelay',
  'nexum.sidebar.collapsed',
  'nexum.sidebar.order',
  'nexum.sidebar.side',
  'nexum.staleThresholdH',
  'nexum.trackJumps',
]);

authRouter.patch('/settings', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const body = req.body as { entries?: Record<string, unknown> };
  const entries = body?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    res.status(400).json({ error: 'entries must be an object' });
    return;
  }
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (SETTINGS_ALLOWLIST.has(k)) filtered[k] = v;
  }
  if (Object.keys(filtered).length === 0) {
    res.json({ ok: true, applied: 0 });
    return;
  }
  await db.query(
    `UPDATE users SET ui_settings = ui_settings || $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(filtered), req.session.userId],
  );
  // Keep the session cache in sync so /auth/me on the same session sees
  // the same data without a DB round-trip.
  if (req.session.prefs) {
    req.session.prefs.uiSettings = { ...(req.session.prefs.uiSettings ?? {}), ...filtered };
  }
  res.json({ ok: true, applied: Object.keys(filtered).length });
});
