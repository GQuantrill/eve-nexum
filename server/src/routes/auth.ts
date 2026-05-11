import { Router } from 'express';
import { db } from '../db.js';

export const authRouter = Router();

const CLIENT_ID     = process.env.EVE_CLIENT_ID!;
const CLIENT_SECRET = process.env.EVE_CLIENT_SECRET!;
const CALLBACK_URL  = process.env.EVE_CALLBACK_URL ?? 'http://localhost:3001/auth/callback';
const FRONTEND_URL  = process.env.FRONTEND_URL ?? 'http://localhost:5174';

const EVE_AUTH_URL  = 'https://login.eveonline.com/v2/oauth/authorize';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';

// GET /auth/login  — redirect to EVE SSO
authRouter.get('/login', (req, res) => {
  const state = Math.random().toString(36).slice(2);
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
    if (err) { res.status(500).send('Session error'); return; }
    res.redirect(`${EVE_AUTH_URL}?${params}`);
  });
});

// GET /auth/callback  — EVE SSO returns here
authRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query as Record<string, string>;

  if (!code || state !== req.session.oauthState) {
    res.status(400).send('Invalid OAuth state');
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
      console.error('Token exchange failed:', err);
      res.status(502).send('Token exchange failed');
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
      res.status(502).send('Could not parse character ID from token');
      return;
    }

    const character = { CharacterID: characterId, CharacterName: jwtPayload.name };

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Upsert user
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO users (character_id, character_name, access_token, refresh_token, token_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (character_id) DO UPDATE SET
         character_name   = EXCLUDED.character_name,
         access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at       = NOW()
       RETURNING id`,
      [character.CharacterID, character.CharacterName, tokens.access_token, tokens.refresh_token, expiresAt],
    );

    const userId = rows[0].id;

    // Create a default map if this is a new user
    await db.query(
      `INSERT INTO maps (user_id, name)
       SELECT $1, 'My Map'
       WHERE NOT EXISTS (SELECT 1 FROM maps WHERE user_id = $1)`,
      [userId],
    );

    req.session.userId        = userId;
    req.session.characterId   = character.CharacterID;
    req.session.characterName = character.CharacterName;

    res.redirect(FRONTEND_URL);
  } catch (err) {
    console.error('Auth callback error:', err);
    res.status(500).send('Authentication failed');
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
  const { rows } = await db.query<{ compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean; panel_order: string[] }>(
    `SELECT compact_mode, snap_to_grid, show_minimap, panel_order FROM users WHERE id = $1`,
    [req.session.userId],
  );
  const prefs = rows[0] ?? { compact_mode: false, snap_to_grid: false, show_minimap: true, panel_order: ['notes', 'signatures'] };
  res.json({
    user: {
      id:            req.session.userId,
      characterId:   req.session.characterId,
      characterName: req.session.characterName,
      compactMode:   prefs.compact_mode,
      snapToGrid:    prefs.snap_to_grid,
      showMinimap:   prefs.show_minimap,
      panelOrder:    prefs.panel_order,
    },
  });
});

// PATCH /auth/preferences
authRouter.patch('/preferences', async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { compactMode, snapToGrid, showMinimap, panelOrder } = req.body as { compactMode?: boolean; snapToGrid?: boolean; showMinimap?: boolean; panelOrder?: string[] };

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (compactMode  !== undefined) { sets.push(`compact_mode = $${vals.length + 1}`); vals.push(compactMode); }
  if (snapToGrid   !== undefined) { sets.push(`snap_to_grid = $${vals.length + 1}`); vals.push(snapToGrid); }
  if (showMinimap  !== undefined) { sets.push(`show_minimap = $${vals.length + 1}`); vals.push(showMinimap); }
  if (panelOrder   !== undefined) { sets.push(`panel_order  = $${vals.length + 1}`); vals.push(panelOrder); }
  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length + 1}`,
    [...vals, req.session.userId],
  );
  res.json({ ok: true });
});
