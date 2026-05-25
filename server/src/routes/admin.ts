import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAdminRead } from '../middleware/requireAdminRead.js';
import { requireReportsAccess, isReportsCharacter, corpScopeFor } from '../middleware/requireReportsAccess.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { invalidateSessionsForUser } from '../utils/sessionInvalidate.js';

const log = createLogger('admin');

export const adminRouter = Router();
adminRouter.use(requireAdmin);

export const adminReadRouter = Router();
adminReadRouter.use(requireAdminRead);

export const reportsRouter = Router();
reportsRouter.use(requireReportsAccess);

const ROLES = ['admin', 'full', 'edit', 'readonly'] as const;
type Role = (typeof ROLES)[number];

// Small in-memory cache for ESI corporation lookups. Tickers don't change
// often (and an admin page reload would re-warm anyway), so a 1-hour TTL is
// plenty. Keyed by corp ID → { ticker, name } or null if ESI returned 404.
interface CorpInfo { ticker: string; name: string }
const CORP_TTL_MS = 60 * 60 * 1000;
const corpCache = new Map<number, { value: CorpInfo | null; at: number }>();

async function resolveCorps(ids: number[]): Promise<Map<number, CorpInfo | null>> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  const now    = Date.now();
  const out    = new Map<number, CorpInfo | null>();
  const todo: number[] = [];

  for (const id of unique) {
    const cached = corpCache.get(id);
    if (cached && now - cached.at < CORP_TTL_MS) out.set(id, cached.value);
    else todo.push(id);
  }

  await Promise.all(todo.map(async (id) => {
    try {
      const r = await fetch(`https://esi.evetech.net/v5/corporations/${id}/`);
      if (!r.ok) {
        corpCache.set(id, { value: null, at: now });
        out.set(id, null);
        return;
      }
      const data = await r.json() as { name?: string; ticker?: string };
      const info: CorpInfo | null = (data.ticker && data.name)
        ? { ticker: data.ticker, name: data.name }
        : null;
      corpCache.set(id, { value: info, at: now });
      out.set(id, info);
    } catch (err) {
      log.error(`corp lookup failed for ${id}:`, err);
      out.set(id, null);
    }
  }));

  return out;
}

// Same shape + cache pattern as resolveCorps, but for alliances. ESI uses
// `name` + `ticker` here too.
const allianceCache = new Map<number, { value: CorpInfo | null; at: number }>();
async function resolveAlliances(ids: number[]): Promise<Map<number, CorpInfo | null>> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  const now    = Date.now();
  const out    = new Map<number, CorpInfo | null>();
  const todo: number[] = [];

  for (const id of unique) {
    const cached = allianceCache.get(id);
    if (cached && now - cached.at < CORP_TTL_MS) out.set(id, cached.value);
    else todo.push(id);
  }

  await Promise.all(todo.map(async (id) => {
    try {
      const r = await fetch(`https://esi.evetech.net/v3/alliances/${id}/`);
      if (!r.ok) {
        allianceCache.set(id, { value: null, at: now });
        out.set(id, null);
        return;
      }
      const data = await r.json() as { name?: string; ticker?: string };
      const info: CorpInfo | null = (data.ticker && data.name)
        ? { ticker: data.ticker, name: data.name }
        : null;
      allianceCache.set(id, { value: info, at: now });
      out.set(id, info);
    } catch (err) {
      log.error(`alliance lookup failed for ${id}:`, err);
      out.set(id, null);
    }
  }));

  return out;
}

// Helper: write an audit entry. Wraps the verbose 6-column insert.
async function audit(
  req: { session: { userId?: number; characterId?: number } },
  targetUserId: number,
  targetCharacterId: number,
  action: string,
  oldValue: string | null,
  newValue: string | null,
) {
  await db.query(
    `INSERT INTO admin_audit
       (actor_user_id, actor_character_id, target_user_id, target_character_id, action, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.session.userId, req.session.characterId, targetUserId, targetCharacterId, action, oldValue, newValue],
  );
}

// GET /api/admin/users — all users with activity stats + corp/blocked status
adminReadRouter.get('/users', async (_req, res) => {
  // Two pre-aggregated subqueries joined into users — avoids the cartesian
  // explosion (COUNT(DISTINCT) over a triple-nested IN) the previous version
  // produced for users with many maps and many signatures.
  const { rows } = await db.query<{
    id:              number;
    characterId:     number;
    characterName:   string;
    role:            string;
    corpId:          number | null;
    allianceId:      number | null;
    blocked:         boolean;
    createdAt:       string;
    lastLogin:       string;
    totalEvents:     number;
    totalSignatures: number;
  }>(`
    SELECT
      u.id,
      u.character_id   AS "characterId",
      u.character_name AS "characterName",
      u.role,
      u.corp_id        AS "corpId",
      u.alliance_id    AS "allianceId",
      u.blocked,
      u.created_at     AS "createdAt",
      u.updated_at     AS "lastLogin",
      COALESCE(e.cnt, 0) AS "totalEvents",
      COALESCE(s.cnt, 0) AS "totalSignatures"
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS cnt FROM user_events GROUP BY user_id
    ) e ON e.user_id = u.id
    LEFT JOIN (
      SELECT m.user_id, COUNT(*)::int AS cnt
      FROM map_signatures ms
      JOIN map_systems sys ON sys.id = ms.system_id
      JOIN maps m          ON m.id  = sys.map_id
      GROUP BY m.user_id
    ) s ON s.user_id = u.id
    ORDER BY u.updated_at DESC
  `);

  const [corpInfo, allianceInfo] = await Promise.all([
    resolveCorps(rows.map((r) => r.corpId).filter((id): id is number => id !== null)),
    resolveAlliances(rows.map((r) => r.allianceId).filter((id): id is number => id !== null)),
  ]);
  const users = rows.map((r) => {
    const cInfo = r.corpId     !== null ? corpInfo.get(r.corpId)         : null;
    const aInfo = r.allianceId !== null ? allianceInfo.get(r.allianceId) : null;
    return {
      ...r,
      corpTicker:     cInfo?.ticker ?? null,
      corpName:       cInfo?.name   ?? null,
      allianceTicker: aInfo?.ticker ?? null,
      allianceName:   aInfo?.name   ?? null,
    };
  });

  res.json({ users });
});

// PATCH /api/admin/users/:id/role
adminRouter.patch('/users/:id/role', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body as { role?: string };

  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  if (!ROLES.includes(role as Role)) {
    res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    return;
  }

  // Block self-demote — an admin removing their own admin role mid-session
  // would lock themselves out unless another admin exists. Forcing them to
  // go through another admin avoids accidental lockout.
  if (userId === req.session.userId && role !== 'admin') {
    res.status(400).json({ error: 'You cannot demote yourself' });
    return;
  }

  const targetRows = await db.query<{ character_id: number; role: string }>(
    `SELECT character_id, role FROM users WHERE id = $1`,
    [userId],
  );
  if (!targetRows.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = targetRows.rows[0];

  // The configured ADMIN_CHAR_ID is auto-promoted to admin on every login,
  // so demoting them here just creates confusing churn next login.
  if (config.adminCharId !== null && target.character_id === config.adminCharId && role !== 'admin') {
    res.status(400).json({ error: 'Cannot demote the configured ADMIN_CHAR_ID' });
    return;
  }

  if (target.role === role) { res.json({ ok: true, unchanged: true }); return; }

  const newRole = role as Role;
  await db.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [newRole, userId]);
  await audit(req, userId, target.character_id, 'role_change', target.role, newRole);

  res.json({ ok: true });
});

// POST /api/admin/users/:id/block — block a user from logging in
adminRouter.post('/users/:id/block', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  if (userId === req.session.userId) {
    res.status(400).json({ error: 'You cannot block yourself' });
    return;
  }

  const { rows } = await db.query<{ character_id: number; blocked: boolean }>(
    `SELECT character_id, blocked FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = rows[0];

  if (config.adminCharId !== null && target.character_id === config.adminCharId) {
    res.status(400).json({ error: 'Cannot block the configured ADMIN_CHAR_ID' });
    return;
  }

  if (target.blocked) { res.json({ ok: true, unchanged: true }); return; }

  await db.query(`UPDATE users SET blocked = TRUE, updated_at = NOW() WHERE id = $1`, [userId]);
  await audit(req, userId, target.character_id, 'block', 'false', 'true');
  // Kill any live sessions so the block takes effect immediately rather than
  // waiting up to the cookie TTL for the user to log out and back in.
  const killed = await invalidateSessionsForUser(userId);

  res.json({ ok: true, sessionsKilled: killed });
});

// POST /api/admin/users/:id/unblock
adminRouter.post('/users/:id/unblock', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }

  const { rows } = await db.query<{ character_id: number; blocked: boolean }>(
    `SELECT character_id, blocked FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = rows[0];

  if (!target.blocked) { res.json({ ok: true, unchanged: true }); return; }

  await db.query(`UPDATE users SET blocked = FALSE, updated_at = NOW() WHERE id = $1`, [userId]);
  await audit(req, userId, target.character_id, 'unblock', 'true', 'false');

  res.json({ ok: true });
});

// POST /api/admin/users/:id/recheck-corp — re-query ESI for the user's
// current corporation. If they've left every allowed corp, auto-block them
// so they can't continue using their current session next time they log in.
// The session itself isn't terminated here — that requires the user to log
// out and back in (or we'd need a session-store invalidate which we don't
// have today).
adminRouter.post('/users/:id/recheck-corp', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }

  const { rows } = await db.query<{ character_id: number; corp_id: number | null; blocked: boolean }>(
    `SELECT character_id, corp_id, blocked FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = rows[0];

  let liveCorpId: number | null = null;
  try {
    const r = await fetch(`https://esi.evetech.net/v4/characters/${target.character_id}/`);
    if (!r.ok) {
      res.status(502).json({ error: `ESI returned ${r.status}` });
      return;
    }
    const data = await r.json() as { corporation_id: number };
    liveCorpId = data.corporation_id;
  } catch (err) {
    log.error('Recheck ESI fetch failed:', err);
    res.status(502).json({ error: 'ESI lookup failed' });
    return;
  }

  const corpChanged   = liveCorpId !== target.corp_id;
  const inAllowedCorp = !config.corpMode || config.corpIds.includes(liveCorpId);
  const shouldBlock   = config.corpMode && !inAllowedCorp && target.character_id !== config.adminCharId;

  if (corpChanged) {
    await db.query(`UPDATE users SET corp_id = $1, updated_at = NOW() WHERE id = $2`, [liveCorpId, userId]);
    await audit(req, userId, target.character_id, 'corp_change',
      target.corp_id !== null ? String(target.corp_id) : null,
      liveCorpId !== null ? String(liveCorpId) : null);
  }

  if (shouldBlock && !target.blocked) {
    await db.query(`UPDATE users SET blocked = TRUE WHERE id = $1`, [userId]);
    await audit(req, userId, target.character_id, 'auto_block_corp_left', 'false', 'true');
    // Live sessions outlive the block flag — drop them so the user can't keep
    // working past their corp departure.
    await invalidateSessionsForUser(userId);
  }

  res.json({
    ok: true,
    corpId:        liveCorpId,
    previousCorpId: target.corp_id,
    inAllowedCorp,
    blocked:       shouldBlock || target.blocked,
  });
});

// GET /api/admin/maps — every corp map in the system with owner + stats.
// Used by the admin Maps tab. Personal (solo) maps are excluded by design:
// they belong to a single user and admins shouldn't be poking at them.
adminRouter.get('/maps', async (_req, res) => {
  const { rows } = await db.query<{
    id:                 string;
    name:               string;
    corpId:             number;
    locked:             boolean;
    lastActiveAt:       string;
    createdAt:          string;
    ownerId:            number;
    ownerCharacterId:   number;
    ownerCharacterName: string;
    systemCount:        number;
    connectionCount:    number;
  }>(`
    SELECT
      m.id,
      m.name,
      m.corp_id        AS "corpId",
      m.locked,
      m.last_active_at AS "lastActiveAt",
      m.created_at     AS "createdAt",
      u.id             AS "ownerId",
      u.character_id   AS "ownerCharacterId",
      u.character_name AS "ownerCharacterName",
      COALESCE(s.cnt, 0) AS "systemCount",
      COALESCE(c.cnt, 0) AS "connectionCount"
    FROM maps m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN (
      SELECT map_id, COUNT(*)::int AS cnt FROM map_systems GROUP BY map_id
    ) s ON s.map_id = m.id
    LEFT JOIN (
      SELECT map_id, COUNT(*)::int AS cnt FROM map_connections GROUP BY map_id
    ) c ON c.map_id = m.id
    WHERE m.corp_id IS NOT NULL
    ORDER BY m.last_active_at DESC
  `);

  const corpInfo = await resolveCorps(rows.map((r) => r.corpId));
  const maps = rows.map((r) => {
    const info = corpInfo.get(r.corpId);
    return {
      ...r,
      corpTicker: info?.ticker ?? null,
      corpName:   info?.name   ?? null,
    };
  });

  res.json({ maps });
});

// POST /api/admin/maps/:id/lock — admin-only "freeze topology" toggle. A
// locked map keeps accepting signatures, structures, and system notes, but
// rejects system / connection / rename mutations from non-admins. Used to
// preserve a chain layout while ops continue.
adminRouter.post('/maps/:id/lock', async (req, res) => {
  const mapId = req.params.id;
  if (!mapId) { res.status(400).json({ error: 'invalid map id' }); return; }

  const { rows } = await db.query<{ name: string; locked: boolean; user_id: number; owner_char: number }>(`
    SELECT m.name, m.locked, m.user_id, u.character_id AS owner_char
    FROM maps m JOIN users u ON u.id = m.user_id
    WHERE m.id = $1
  `, [mapId]);
  if (!rows.length) { res.status(404).json({ error: 'Map not found' }); return; }
  const m = rows[0];

  if (m.locked) { res.json({ ok: true, unchanged: true }); return; }

  await db.query(`UPDATE maps SET locked = TRUE, updated_at = NOW() WHERE id = $1`, [mapId]);
  await audit(req, m.user_id, m.owner_char, 'force_lock_map', null, m.name);
  res.json({ ok: true });
});

// POST /api/admin/maps/:id/unlock — force-unlock any locked map, regardless
// of who owns it. Used when an owner has logged out and left their corp map
// locked.
adminRouter.post('/maps/:id/unlock', async (req, res) => {
  const mapId = req.params.id;
  if (!mapId) { res.status(400).json({ error: 'invalid map id' }); return; }

  const { rows } = await db.query<{ name: string; locked: boolean; user_id: number; owner_char: number }>(`
    SELECT m.name, m.locked, m.user_id, u.character_id AS owner_char
    FROM maps m JOIN users u ON u.id = m.user_id
    WHERE m.id = $1
  `, [mapId]);
  if (!rows.length) { res.status(404).json({ error: 'Map not found' }); return; }
  const m = rows[0];

  if (!m.locked) { res.json({ ok: true, unchanged: true }); return; }

  await db.query(`UPDATE maps SET locked = FALSE, updated_at = NOW() WHERE id = $1`, [mapId]);
  await audit(req, m.user_id, m.owner_char, 'force_unlock_map', m.name, null);
  res.json({ ok: true });
});

// DELETE /api/admin/maps/:id — force-delete any map. ON DELETE CASCADE on
// map_systems / map_connections / map_signatures handles the rest.
adminRouter.delete('/maps/:id', async (req, res) => {
  const mapId = req.params.id;
  if (!mapId) { res.status(400).json({ error: 'invalid map id' }); return; }

  const { rows } = await db.query<{ name: string; user_id: number; owner_char: number }>(`
    SELECT m.name, m.user_id, u.character_id AS owner_char
    FROM maps m JOIN users u ON u.id = m.user_id
    WHERE m.id = $1
  `, [mapId]);
  if (!rows.length) { res.status(404).json({ error: 'Map not found' }); return; }
  const m = rows[0];

  await db.query(`DELETE FROM maps WHERE id = $1`, [mapId]);
  await audit(req, m.user_id, m.owner_char, 'force_delete_map', m.name, null);
  res.json({ ok: true });
});

// Maps a window query-param value to a Postgres interval string. NULL means
// "no time bound" — used for the 'all' window. Keys are the only values the
// frontend is allowed to send.
const WINDOW_INTERVALS: Record<string, string | null> = {
  '24h':   '24 hours',
  'week':  '7 days',
  'month': '30 days',
  'year':  '365 days',
  'all':   null,
};

function parseWindow(raw: unknown): { key: string; interval: string | null } {
  const key = typeof raw === 'string' && raw in WINDOW_INTERVALS ? raw : 'all';
  return { key, interval: WINDOW_INTERVALS[key] };
}

const USER_FILTERS = new Set(['logins', 'signatures', 'structures']);

// GET /api/admin/reports/users — per-user activity summary.
//   ?filter=logins|signatures|structures (optional)
//   ?window=24h|week|month|year|all       (default 'all')
//
// Filter narrows rows to users whose chosen activity falls inside the
// window. With no filter (default) every user is returned. Numeric columns
// stay lifetime — the filter is purely a row-inclusion criterion.
reportsRouter.get('/users', async (req, res) => {
  const scope = corpScopeFor(req);
  if (scope === null) { res.status(403).json({ error: 'No corp affiliation' }); return; }
  const filterRaw = typeof req.query.filter === 'string' ? req.query.filter : '';
  const filter    = USER_FILTERS.has(filterRaw) ? filterRaw : null;
  const window    = parseWindow(req.query.window);

  // Corp scope is $1 if present (admin); reports character has no scope
  // param and the predicate collapses to TRUE. Subsequent params start
  // immediately after.
  const params: unknown[] = scope.param !== null ? [scope.param] : [];
  const corpSql = scope.sql(1);
  // Admins additionally only see users in their corp; reports char sees all.
  const userScope = scope.param !== null ? `u.corp_id = $1` : null;

  // Row-inclusion conditions (user-scope + filter EXISTS). Joined with AND.
  const conditions: string[] = [];
  if (userScope) conditions.push(userScope);
  if (filter && window.interval) {
    params.push(window.interval);
    const intervalParam = `$${params.length}::interval`;
    if (filter === 'logins') {
      conditions.push(`u.updated_at >= NOW() - ${intervalParam}`);
    } else if (filter === 'signatures') {
      conditions.push(`EXISTS (
        SELECT 1 FROM map_signatures s
        JOIN map_systems sys ON sys.id = s.system_id
        JOIN maps        m   ON m.id   = sys.map_id
        WHERE s.created_by_user_id = u.id
          AND ${corpSql}
          AND s.created_at >= NOW() - ${intervalParam}
      )`);
    } else if (filter === 'structures') {
      conditions.push(`EXISTS (
        SELECT 1 FROM map_structures st
        JOIN map_systems sys ON sys.id = st.system_id
        JOIN maps        m   ON m.id   = sys.map_id
        WHERE st.created_by_user_id = u.id
          AND ${corpSql}
          AND st.created_at >= NOW() - ${intervalParam}
      )`);
    }
  } else if (filter && !window.interval) {
    // filter + 'all' window → at least one such activity ever
    if (filter === 'signatures') {
      conditions.push(`EXISTS (
        SELECT 1 FROM map_signatures s
        JOIN map_systems sys ON sys.id = s.system_id
        JOIN maps        m   ON m.id   = sys.map_id
        WHERE s.created_by_user_id = u.id AND ${corpSql}
      )`);
    } else if (filter === 'structures') {
      conditions.push(`EXISTS (
        SELECT 1 FROM map_structures st
        JOIN map_systems sys ON sys.id = st.system_id
        JOIN maps        m   ON m.id   = sys.map_id
        WHERE st.created_by_user_id = u.id AND ${corpSql}
      )`);
    }
    // logins + all → no extra activity predicate (user-scope still applies)
  }
  const inclusionWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(`
    WITH last_corp_sig AS (
      SELECT s.created_by_user_id AS user_id, MAX(s.created_at) AS ts
      FROM map_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} AND s.created_by_user_id IS NOT NULL
      GROUP BY s.created_by_user_id
    ),
    last_corp_struct AS (
      SELECT st.created_by_user_id AS user_id, MAX(st.created_at) AS ts, COUNT(*)::int AS cnt
      FROM map_structures st
      JOIN map_systems sys ON sys.id = st.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} AND st.created_by_user_id IS NOT NULL
      GROUP BY st.created_by_user_id
    ),
    sig_breakdown AS (
      -- Count live signatures (not the historical event log) so deletions
      -- are reflected. corp scope applies via the maps join so an admin
      -- viewing the report only sees activity on their corp's maps.
      SELECT s.created_by_user_id AS user_id, s.sig_type, COUNT(*)::int AS cnt
      FROM map_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE s.created_by_user_id IS NOT NULL
        AND s.sig_type IS NOT NULL
        AND ${corpSql}
      GROUP BY s.created_by_user_id, s.sig_type
    ),
    corp_system_events AS (
      SELECT e.user_id, e.event_type, COUNT(*)::int AS cnt
      FROM user_events e
      JOIN maps m ON m.id = e.map_id
      WHERE e.event_type IN ('system_add', 'system_delete')
        AND ${corpSql}
      GROUP BY e.user_id, e.event_type
    )
    SELECT
      u.id,
      u.character_id   AS "characterId",
      u.character_name AS "characterName",
      u.role,
      u.corp_id        AS "corpId",
      u.alliance_id    AS "allianceId",
      u.updated_at     AS "lastLogin",
      lcs.ts           AS "lastCorpSigAt",
      lcst.ts          AS "lastCorpStructAt",
      COALESCE(lcst.cnt, 0) AS "totalCorpStructures",
      COALESCE(
        (SELECT cnt FROM corp_system_events
          WHERE user_id = u.id AND event_type = 'system_add'),
        0
      ) AS "systemsAdded",
      COALESCE(
        (SELECT cnt FROM corp_system_events
          WHERE user_id = u.id AND event_type = 'system_delete'),
        0
      ) AS "systemsDeleted",
      COALESCE(
        (SELECT jsonb_object_agg(sb.sig_type, sb.cnt)
         FROM sig_breakdown sb WHERE sb.user_id = u.id),
        '{}'::jsonb
      ) AS "sigTypeCounts"
    FROM users u
    LEFT JOIN last_corp_sig    lcs  ON lcs.user_id  = u.id
    LEFT JOIN last_corp_struct lcst ON lcst.user_id = u.id
    ${inclusionWhere}
    ORDER BY u.character_name
  `, params);

  const corpIds      = (rows as { corpId: number | null }[]).map((r) => r.corpId).filter((id): id is number => id !== null);
  const allianceIds  = (rows as { allianceId?: number | null }[]).map((r) => r.allianceId ?? null).filter((id): id is number => id !== null);
  const [corpInfo, allianceInfo] = await Promise.all([
    resolveCorps(corpIds),
    resolveAlliances(allianceIds),
  ]);
  const users = (rows as Array<Record<string, unknown> & { corpId: number | null; allianceId: number | null }>).map((r) => {
    const cInfo = r.corpId     !== null ? corpInfo.get(r.corpId)         : null;
    const aInfo = r.allianceId !== null ? allianceInfo.get(r.allianceId) : null;
    return {
      ...r,
      corpTicker:     cInfo?.ticker ?? null,
      corpName:       cInfo?.name   ?? null,
      allianceTicker: aInfo?.ticker ?? null,
      allianceName:   aInfo?.name   ?? null,
    };
  });

  res.json({ users, filter, window: window.key });
});

// Chart bucketing per window. Each entry describes the date_trunc unit, the
// number of buckets to emit via generate_series, the step interval, and the
// human label format. 'all' tries to span from the oldest sig — handled
// dynamically below.
// Day-month-year tick labels for a European default. 24h shows hour-only;
// week and month show DD-MM (year is implied, saves space on busy x-axes);
// year and all-time show MM-YYYY.
const SYSTEMS_CHART_SPEC: Record<string, { trunc: string; step: string; count: number; label: string } | 'all'> = {
  '24h':   { trunc: 'hour',  step: '1 hour',   count: 24, label: 'HH24:00' },
  'week':  { trunc: 'day',   step: '1 day',    count: 7,  label: 'DD-MM' },
  'month': { trunc: 'day',   step: '1 day',    count: 30, label: 'DD-MM' },
  'year':  { trunc: 'month', step: '1 month',  count: 12, label: 'MM-YYYY' },
  'all':   'all',
};

// GET /api/admin/reports/systems — aggregate signatures across every map
// (personal + corp), optionally constrained to ?window=24h|week|month|year|all
// (default 'all'). The chart-series bucketing adapts to the window: hourly for 24h,
// daily for week/month, monthly for year, monthly-from-oldest for all.
reportsRouter.get('/systems', async (req, res) => {
  const scope = corpScopeFor(req);
  if (scope === null) { res.status(403).json({ error: 'No corp affiliation' }); return; }
  const window = parseWindow(req.query.window);
  const interval = window.interval; // null when 'all'

  // Build per-query params. Corp scope param (if any) is always $1, so
  // subsequent params start at $2. Each query rebuilds its own params
  // array to keep indices straightforward.
  const scopeParams: unknown[] = scope.param !== null ? [scope.param] : [];
  const corpSql = scope.sql(1); // 'TRUE' for reports char; 'm.corp_id = $1' for admin
  const buildBase = (extra: unknown[] = []) => [...scopeParams, ...extra];
  const intervalIdx = scopeParams.length + 1;
  const windowClause = interval ? `AND s.created_at >= NOW() - $${intervalIdx}::interval` : '';
  const windowParams: unknown[] = interval ? [interval] : [];

  const [typeRows, whRows, totalRows] = await Promise.all([
    db.query<{ sig_type: string; cnt: number }>(`
      SELECT s.sig_type, COUNT(*)::int AS cnt
      FROM map_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} ${windowClause}
      GROUP BY s.sig_type
    `, buildBase(windowParams)),
    db.query<{ wh_type: string; cnt: number }>(`
      SELECT UPPER(s.wh_type) AS wh_type, COUNT(*)::int AS cnt
      FROM map_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql}
        AND s.sig_type = 'wormhole'
        AND COALESCE(NULLIF(TRIM(s.wh_type), ''), NULL) IS NOT NULL
        ${windowClause}
      GROUP BY UPPER(s.wh_type)
      ORDER BY cnt DESC, wh_type
    `, buildBase(windowParams)),
    db.query<{ total: number }>(`
      SELECT COUNT(*)::int AS total
      FROM map_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} ${windowClause}
    `, buildBase(windowParams)),
  ]);

  // Build the time series for the chart. Bucket size adapts to the window.
  const spec = SYSTEMS_CHART_SPEC[window.key];
  let dailyTotals: Array<{ day: string; count: number }>;

  if (spec === 'all') {
    // Span from the oldest visible sig, bucketed monthly. No-op if there
    // aren't any sigs yet — return an empty series.
    const { rows: dailyRows } = await db.query<{ day: string; count: number }>(`
      WITH bounds AS (
        SELECT date_trunc('month', MIN(s.created_at)) AS start_month
        FROM map_signatures s
        JOIN map_systems sys ON sys.id = s.system_id
        JOIN maps         m  ON m.id   = sys.map_id
        WHERE ${corpSql}
      ),
      months AS (
        SELECT generate_series(
          (SELECT start_month FROM bounds),
          date_trunc('month', NOW()),
          INTERVAL '1 month'
        ) AS bucket
      ),
      sig_counts AS (
        SELECT date_trunc('month', s.created_at) AS bucket, COUNT(*)::int AS cnt
        FROM map_signatures s
        JOIN map_systems sys ON sys.id = s.system_id
        JOIN maps         m  ON m.id   = sys.map_id
        WHERE ${corpSql}
        GROUP BY 1
      )
      SELECT to_char(months.bucket, 'MM-YYYY') AS day,
             COALESCE(sig_counts.cnt, 0)        AS count
      FROM months
      LEFT JOIN sig_counts ON sig_counts.bucket = months.bucket
      ORDER BY months.bucket
    `, scopeParams);
    dailyTotals = dailyRows.map((r) => ({ day: r.day, count: r.count }));
  } else {
    // spec.count comes after the corp scope param (if any).
    const countIdx = scopeParams.length + 1;
    const { rows: dailyRows } = await db.query<{ day: string; count: number }>(`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('${spec.trunc}', NOW()) - ($${countIdx}::int - 1) * INTERVAL '${spec.step}',
          date_trunc('${spec.trunc}', NOW()),
          INTERVAL '${spec.step}'
        ) AS bucket
      ),
      sig_counts AS (
        SELECT date_trunc('${spec.trunc}', s.created_at) AS bucket, COUNT(*)::int AS cnt
        FROM map_signatures s
        JOIN map_systems sys ON sys.id = s.system_id
        JOIN maps         m  ON m.id   = sys.map_id
        WHERE ${corpSql}
          AND s.created_at >= date_trunc('${spec.trunc}', NOW()) - ($${countIdx}::int - 1) * INTERVAL '${spec.step}'
        GROUP BY 1
      )
      SELECT to_char(buckets.bucket, '${spec.label}') AS day,
             COALESCE(sig_counts.cnt, 0)               AS count
      FROM buckets
      LEFT JOIN sig_counts ON sig_counts.bucket = buckets.bucket
      ORDER BY buckets.bucket
    `, [...scopeParams, spec.count]);
    dailyTotals = dailyRows.map((r) => ({ day: r.day, count: r.count }));
  }

  const byType: Record<string, number> = {};
  for (const r of typeRows.rows) byType[r.sig_type] = r.cnt;

  const byWormholeType: Array<{ whType: string; count: number }> =
    whRows.rows.map((r) => ({ whType: r.wh_type, count: r.cnt }));

  res.json({
    total: totalRows.rows[0]?.total ?? 0,
    byType,
    byWormholeType,
    dailyTotals,
    window: window.key,
  });
});

// GET /api/admin/reports/ghost-sites — every K-space system where a sig
// ending in "Covert Research Facility" has been observed, with the
// metadata captured at first sighting (sun type, planet/moon counts).
// Cluster-wide intel — reports character only; corp admins can't see
// this view (they'd only see noise from their own members anyway).
reportsRouter.get('/ghost-sites', async (req, res) => {
  if (!isReportsCharacter(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { rows } = await db.query(`
    SELECT
      eve_system_id      AS "eveSystemId",
      system_name        AS "systemName",
      constellation_name AS "constellationName",
      region_name        AS "regionName",
      system_class       AS "systemClass",
      sun_type           AS "sunType",
      planet_count       AS "planetCount",
      moon_count         AS "moonCount",
      observations,
      first_seen_at      AS "firstSeenAt",
      last_seen_at       AS "lastSeenAt"
    FROM ghost_site_systems
    ORDER BY region_name, constellation_name, system_name
  `);
  res.json({ rows });
});

// GET /api/admin/audit — recent admin actions (newest first)
adminRouter.get('/audit', async (_req, res) => {
  const { rows } = await db.query(`
    SELECT
      a.id,
      a.created_at         AS "createdAt",
      a.action,
      a.old_value          AS "oldValue",
      a.new_value          AS "newValue",
      a.actor_character_id AS "actorCharacterId",
      au.character_name    AS "actorCharacterName",
      a.target_character_id AS "targetCharacterId",
      tu.character_name    AS "targetCharacterName"
    FROM admin_audit a
    LEFT JOIN users au ON au.id = a.actor_user_id
    LEFT JOIN users tu ON tu.id = a.target_user_id
    ORDER BY a.created_at DESC
    LIMIT 200
  `);
  res.json({ entries: rows });
});
