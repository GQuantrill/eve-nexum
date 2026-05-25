import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { encryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';
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

// GET /auth/login  — redirect to EVE SSO
authRouter.get('/login', (req, res) => {
  const state = randomBytes(32).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  CALLBACK_URL,
    client_id:     CLIENT_ID,
    scope: [
          'esi-location.read_location.v1',
          'esi-location.read_ship_type.v1',
          'esi-universe.read_structures.v1',
          'esi-corporations.read_corporation_membership.v1',
          'esi-ui.open_window.v1',
          'esi-ui.write_waypoint.v1',
          'esi-characters.read_corporation_roles.v1',
          'esi-location.read_online.v1',
          // Read player standings (contacts) so the UI can colour-tag
          // structures / killboard / sov by your standing toward each
          // entity. Corp / alliance reads only succeed for characters with
          // the Contact Manager role; reads gracefully no-op otherwise.
          'esi-characters.read_contacts.v1',
          'esi-corporations.read_contacts.v1',
          'esi-alliances.read_contacts.v1',
          // Auto-discover corp-owned structures (citadels, refineries,
          // etc.) so the Structures pane can pre-populate them per system
          // without manual entry. Only works for characters with the
          // Station Manager or Director role; the puller silently no-ops
          // for everyone else.
          'esi-corporations.read_structures.v1',
          // Fleet member tracking — show fleet-mate locations on the map as
          // purple dots. Requires the character to be the fleet boss or a
          // wing/squad commander; ESI returns 403 to everyone else and the
          // UI degrades silently to "no fleet visibility".
          'esi-fleets.read_fleet.v1',
        ].join(' '),
    state,
  });

  req.session.save((err) => {
    if (err) { res.status(500).json({ error: 'Session error' }); return; }
    res.redirect(`${EVE_AUTH_URL}?${params}`);
  });
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
      const esiChar = await fetch(`https://esi.evetech.net/v4/characters/${characterId}/`);
      if (!esiChar.ok) {
        if (config.corpMode) {
          res.redirect(`${FRONTEND_URL}?error=corp_check_failed`);
          return;
        }
        // Solo mode: ESI hiccup shouldn't block login.
        log.error(`ESI character lookup failed: ${esiChar.status}`);
      } else {
        const charData = await esiChar.json() as { corporation_id: number; alliance_id?: number };
        userCorpId     = charData.corporation_id;
        userAllianceId = charData.alliance_id ?? null;
        if (config.corpMode && !config.corpIds.includes(userCorpId)) {
          res.redirect(`${FRONTEND_URL}?error=not_in_corp`);
          return;
        }
      }
    } catch {
      if (config.corpMode) {
        res.redirect(`${FRONTEND_URL}?error=corp_check_failed`);
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
      `INSERT INTO users (character_id, character_name, access_token, refresh_token, token_expires_at, role, corp_id, alliance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $8, $10)
       ON CONFLICT (character_id) DO UPDATE SET
         character_name   = EXCLUDED.character_name,
         access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
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
      res.redirect(`${FRONTEND_URL}?error=blocked`);
      return;
    }

    // First login: seed a starter "Demo Map" so the canvas isn't blank.
    // No-op when the user already has a map.
    await seedDemoMap(userId);

    // Snapshot prefs into the session so /auth/me can answer without a DB call.
    const prefRows = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; uniform_size: boolean; show_statics: boolean; connection_thickness: string; route_mode: string; route_include_bridges: boolean; ui_zoom: string; ui_settings: Record<string, unknown>; panel_order: string[] }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics, connection_thickness, route_mode, route_include_bridges, ui_zoom, ui_settings, panel_order FROM users WHERE id = $1`,
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
    req.session.prefs         = {
      compactMode: p?.compact_mode ?? false,
      snapToGrid:  p?.snap_to_grid ?? false,
      showMinimap: p?.show_minimap ?? true,
      uniformSize: p?.uniform_size ?? true,
      showStatics: p?.show_statics ?? true,
      connectionThickness: p?.connection_thickness ?? 'standard',
      routeMode:   p?.route_mode ?? 'shortest',
      routeIncludeBridges: p?.route_include_bridges ?? false,
      uiZoom:      p?.ui_zoom != null ? Number(p.ui_zoom) : 1,
      uiSettings:  p?.ui_settings ?? {},
      panelOrder:  p?.panel_order  ?? ['notes', 'signatures'],
    };

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => err ? reject(err) : resolve());
    });

    // Fire-and-forget standings refresh. We pass the *raw* access token
    // here (not the encrypted-at-rest version) since it's already in
    // memory and avoids a decrypt round-trip. The service swallows its
    // own errors so a bad ESI response doesn't break login.
    refreshStandingsForUser({
      userId,
      characterId,
      corpId:      userCorpId,
      allianceId:  userAllianceId,
      accessToken: tokens.access_token,
    }).catch((err) => log.error('standings refresh kickoff failed:', err));

    res.redirect(FRONTEND_URL);
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
    const { rows } = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; uniform_size: boolean; show_statics: boolean; connection_thickness: string; route_mode: string; route_include_bridges: boolean; ui_zoom: string; ui_settings: Record<string, unknown>; panel_order: string[]; role: string }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics, connection_thickness, route_mode, route_include_bridges, ui_zoom, ui_settings, panel_order, role FROM users WHERE id = $1`,
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
      routeIncludeBridges: row?.route_include_bridges ?? false,
      uiZoom:      row?.ui_zoom != null ? Number(row.ui_zoom) : 1,
      uiSettings:  row?.ui_settings ?? {},
      panelOrder:  row?.panel_order  ?? ['notes', 'signatures'],
    };
    role = (row?.role as 'admin' | 'full' | 'edit' | 'readonly') ?? 'readonly';
    req.session.prefs = prefs;
    req.session.role  = role;
  }

  res.json({
    user: {
      id:            req.session.userId,
      characterId:   req.session.characterId,
      characterName: req.session.characterName,
      role,
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
      routeIncludeBridges: prefs.routeIncludeBridges ?? false,
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
  const { compactMode, snapToGrid, showMinimap, uniformSize, showStatics, connectionThickness, routeMode, routeIncludeBridges, uiZoom, panelOrder } = req.body as { compactMode?: boolean; snapToGrid?: boolean; showMinimap?: boolean; uniformSize?: boolean; showStatics?: boolean; connectionThickness?: string; routeMode?: string; routeIncludeBridges?: boolean; uiZoom?: number; panelOrder?: unknown };
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
  if (typeof routeIncludeBridges === 'boolean') {
    sets.push(`route_include_bridges = $${vals.length + 1}`); vals.push(routeIncludeBridges);
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
    if (typeof routeIncludeBridges === 'boolean') {
      req.session.prefs.routeIncludeBridges = routeIncludeBridges;
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
