import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { encryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';

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

    // In corp mode, verify the character belongs to the corp — fail-closed
    if (config.corpMode) {
      try {
        const esiChar = await fetch(`https://esi.evetech.net/v4/characters/${characterId}/`);
        if (!esiChar.ok) {
          res.redirect(`${FRONTEND_URL}?error=corp_check_failed`);
          return;
        }
        const charData = await esiChar.json() as { corporation_id: number };
        if (charData.corporation_id !== config.corpId) {
          res.redirect(`${FRONTEND_URL}?error=not_in_corp`);
          return;
        }
      } catch {
        res.redirect(`${FRONTEND_URL}?error=corp_check_failed`);
        return;
      }
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Determine role: ADMIN_CHAR_ID always gets admin; others keep existing role or default to standard
    const isAdminChar = characterId === config.adminCharId;

    const { rows } = await db.query<{ id: number; role: string }>(
      `INSERT INTO users (character_id, character_name, access_token, refresh_token, token_expires_at, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (character_id) DO UPDATE SET
         character_name   = EXCLUDED.character_name,
         access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         role             = CASE WHEN $7::int IS NOT NULL AND users.character_id = $7::int THEN 'admin' ELSE users.role END,
         updated_at       = NOW()
       RETURNING id, role`,
      [characterId, jwtPayload.name, encryptToken(tokens.access_token), encryptToken(tokens.refresh_token), expiresAt,
       isAdminChar ? 'admin' : 'readonly', config.adminCharId],
    );

    const userId = rows[0].id;
    const role   = rows[0].role as 'admin' | 'member' | 'readonly';

    // Create a default personal map if this is a new user
    await db.query(
      `INSERT INTO maps (user_id, name)
       SELECT $1, 'My Map'
       WHERE NOT EXISTS (SELECT 1 FROM maps WHERE user_id = $1)`,
      [userId],
    );

    // Snapshot prefs into the session so /auth/me can answer without a DB call.
    const prefRows = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; panel_order: string[] }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, panel_order FROM users WHERE id = $1`,
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
    req.session.prefs         = {
      compactMode: p?.compact_mode ?? false,
      snapToGrid:  p?.snap_to_grid ?? false,
      showMinimap: p?.show_minimap ?? true,
      panelOrder:  p?.panel_order  ?? ['notes', 'signatures'],
    };

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => err ? reject(err) : resolve());
    });

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
    const { rows } = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; panel_order: string[]; role: string }>(
      `SELECT compact_mode, snap_to_grid, show_minimap, panel_order, role FROM users WHERE id = $1`,
      [req.session.userId],
    );
    const row = rows[0];
    prefs = {
      compactMode: row?.compact_mode ?? false,
      snapToGrid:  row?.snap_to_grid ?? false,
      showMinimap: row?.show_minimap ?? true,
      panelOrder:  row?.panel_order  ?? ['notes', 'signatures'],
    };
    role = (row?.role as 'admin' | 'member' | 'readonly') ?? 'readonly';
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
      panelOrder:    prefs.panelOrder,
    },
  });
});

// PATCH /auth/preferences
const MAX_PANELS = 16;
const MAX_PANEL_KEY_LEN = 64;

authRouter.patch('/preferences', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { compactMode, snapToGrid, showMinimap, panelOrder } = req.body as { compactMode?: boolean; snapToGrid?: boolean; showMinimap?: boolean; panelOrder?: unknown };

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof compactMode === 'boolean') { sets.push(`compact_mode = $${vals.length + 1}`); vals.push(compactMode); }
  if (typeof snapToGrid  === 'boolean') { sets.push(`snap_to_grid = $${vals.length + 1}`); vals.push(snapToGrid); }
  if (typeof showMinimap === 'boolean') { sets.push(`show_minimap = $${vals.length + 1}`); vals.push(showMinimap); }
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
    if (Array.isArray(panelOrder))        req.session.prefs.panelOrder  = panelOrder as string[];
  }

  res.json({ ok: true });
});
