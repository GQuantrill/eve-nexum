import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { refreshStandingsForUser } from '../services/standings.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('standings');

export const standingsRouter = Router();
standingsRouter.use(requireAuth);

type ContactKind = 'character' | 'corporation' | 'alliance' | 'faction';

// GET /api/standings/me — returns the three standings buckets visible to
// the logged-in character: their personal contacts, their corp's contacts
// (if a corp Contact Manager has ever logged in), and their alliance's
// contacts (likewise). Maps are keyed `"<kind>:<id>"` for fast lookup on
// the client.
//
// The frontend's useStandings hook compresses these into a single
// "effective standing" per target — most negative across the three.
standingsRouter.get('/me', async (req, res) => {
  const userId = req.session.userId!;

  const { rows: userRows } = await db.query<{ character_id: number; corp_id: number | null; alliance_id: number | null }>(
    `SELECT character_id, corp_id, alliance_id FROM users WHERE id = $1`,
    [userId],
  );
  if (!userRows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const { character_id, corp_id, alliance_id } = userRows[0];

  const [charRows, corpRows, allianceRows, refreshRows] = await Promise.all([
    db.query<{ contact_kind: ContactKind; contact_id: number; standing: number }>(
      `SELECT contact_kind, contact_id, standing
       FROM character_standings WHERE character_id = $1`,
      [character_id],
    ),
    corp_id !== null
      ? db.query<{ contact_kind: ContactKind; contact_id: number; standing: number }>(
          `SELECT contact_kind, contact_id, standing
           FROM corp_standings WHERE corp_id = $1`,
          [corp_id],
        )
      : Promise.resolve({ rows: [] as Array<{ contact_kind: ContactKind; contact_id: number; standing: number }> }),
    alliance_id !== null
      ? db.query<{ contact_kind: ContactKind; contact_id: number; standing: number }>(
          `SELECT contact_kind, contact_id, standing
           FROM alliance_standings WHERE alliance_id = $1`,
          [alliance_id],
        )
      : Promise.resolve({ rows: [] as Array<{ contact_kind: ContactKind; contact_id: number; standing: number }> }),
    db.query<{ owner_kind: string; last_fetched_at: string }>(
      `SELECT owner_kind, last_fetched_at FROM standings_refresh
       WHERE (owner_kind = 'character' AND owner_id = $1)
          OR (owner_kind = 'corp'      AND owner_id = $2)
          OR (owner_kind = 'alliance'  AND owner_id = $3)`,
      [character_id, corp_id ?? 0, alliance_id ?? 0],
    ),
  ]);

  function toMap(rows: Array<{ contact_kind: ContactKind; contact_id: number; standing: number }>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.contact_kind}:${r.contact_id}`] = r.standing;
    return out;
  }

  const refreshedAt: Record<string, string> = {};
  for (const r of refreshRows.rows) refreshedAt[r.owner_kind] = r.last_fetched_at;

  res.json({
    characterId: character_id,
    corpId:      corp_id,
    allianceId:  alliance_id,
    character:   toMap(charRows.rows),
    corp:        toMap(corpRows.rows),
    alliance:    toMap(allianceRows.rows),
    refreshedAt,
  });
});

// POST /api/standings/refresh — force a refresh using the user's stored
// access token. Bypasses the 6h TTL. Returns whether each of the three
// ESI calls succeeded (200), came back forbidden (403 — missing scope or
// role), or failed otherwise. Useful both as a debug tool and as a
// "refresh my standings now" button.
//
// Body { scope: 'org' } refreshes ONLY corp + alliance (skips personal) — used
// by the access-page sync, which must never touch personal contacts. The
// default ('all') refreshes personal too, for the system-info map tint.
standingsRouter.post('/refresh', async (req, res) => {
  const userId = req.session.userId!;
  const orgOnly = (req.body as { scope?: string } | undefined)?.scope === 'org';

  const { rows } = await db.query<{
    character_id: number;
    corp_id:      number | null;
    alliance_id:  number | null;
    access_token: string;
  }>(
    `SELECT character_id, corp_id, alliance_id, access_token FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const { character_id, corp_id, alliance_id, access_token } = rows[0];

  // Clear the throttle row(s) so refreshStandingsForUser doesn't skip. An
  // org-only sync leaves the personal throttle alone (it isn't refreshed).
  if (!orgOnly) {
    await db.query(
      `DELETE FROM standings_refresh WHERE owner_kind = 'character' AND owner_id = $1`,
      [character_id],
    );
  }
  await db.query(
    `DELETE FROM standings_refresh
     WHERE (owner_kind = 'corp'     AND owner_id = $1)
        OR (owner_kind = 'alliance' AND owner_id = $2)`,
    [corp_id ?? 0, alliance_id ?? 0],
  );

  let token: string;
  try { token = decryptToken(access_token); }
  catch (err) {
    log.error('failed to decrypt access token:', err);
    res.status(500).json({ error: 'Cannot read stored token — log out and back in' });
    return;
  }

  try {
    await refreshStandingsForUser({
      userId,
      characterId: Number(character_id),
      corpId:      corp_id,
      allianceId:  alliance_id,
      accessToken: token,
      scope:       orgOnly ? 'org' : 'all',
    });
  } catch (err) {
    log.error('manual refresh failed:', err);
    res.status(502).json({ error: 'Refresh failed — check server logs' });
    return;
  }

  // Read back what was actually stored so the client can see the result.
  const [charCnt, corpCnt, allianceCnt, refreshRows] = await Promise.all([
    db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM character_standings WHERE character_id = $1`, [character_id]),
    corp_id !== null
      ? db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM corp_standings WHERE corp_id = $1`, [corp_id])
      : Promise.resolve({ rows: [{ count: 0 }] }),
    alliance_id !== null
      ? db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM alliance_standings WHERE alliance_id = $1`, [alliance_id])
      : Promise.resolve({ rows: [{ count: 0 }] }),
    db.query<{ owner_kind: string; last_fetched_at: string }>(
      `SELECT owner_kind, last_fetched_at FROM standings_refresh
       WHERE (owner_kind = 'character' AND owner_id = $1)
          OR (owner_kind = 'corp'      AND owner_id = $2)
          OR (owner_kind = 'alliance'  AND owner_id = $3)`,
      [character_id, corp_id ?? 0, alliance_id ?? 0],
    ),
  ]);

  const refreshedAt: Record<string, string> = {};
  for (const r of refreshRows.rows) refreshedAt[r.owner_kind] = r.last_fetched_at;

  res.json({
    ok: true,
    counts: {
      character: charCnt.rows[0]?.count ?? 0,
      corp:      corpCnt.rows[0]?.count ?? 0,
      alliance:  allianceCnt.rows[0]?.count ?? 0,
    },
    refreshedAt,
    // If a bucket has *no* refreshedAt row after a forced refresh, the
    // ESI call returned 403 (missing scope or role). Helps the client tell
    // "you have no contacts" from "your token doesn't carry the scope".
    succeeded: {
      character: 'character' in refreshedAt,
      corp:      'corp'      in refreshedAt,
      alliance:  'alliance'  in refreshedAt,
    },
  });
});
