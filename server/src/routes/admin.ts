import { Router, type Request } from 'express';
import { esiFetch } from '../utils/esi.js';
import { db } from '../db.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAdminRead } from '../middleware/requireAdminRead.js';
import { requireReportsAccess, isReportsCharacter, corpScopeFor } from '../middleware/requireReportsAccess.js';
import { isAdmin, isAllianceAdmin } from '../middleware/authContext.js';
import { config } from '../config.js';
import { isDiscordWebhookUrl } from '../services/discord.js';
import { getVersionStatus } from '../services/versionCheck.js';
import { createLogger } from '../utils/logger.js';
import { invalidateSessionsForUser } from '../utils/sessionInvalidate.js';
import { audit } from '../services/audit.js';
import { resolveEntityNames } from '../services/entityNames.js';
import {
  standingPermitsTarget, grantKindAllowedForInstall,
  requiresPositiveStanding, type GrantKind,
} from '../services/accessGrants.js';
import {
  getStandingsLoginSettings, setSetting,
  STANDINGS_LOGIN_ENABLED, STANDINGS_LOGIN_THRESHOLD,
} from '../services/appSettings.js';
import { revalidateActiveSessions } from '../services/accessRevalidate.js';

const log = createLogger('admin');

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/version — running version vs the latest upstream GitHub release.
// Admin + alliance-admin only (requireAdmin). Result is cached server-side, so
// admin clients can poll it cheaply without hitting GitHub's rate limit.
adminRouter.get('/version', async (_req, res) => {
  res.json(await getVersionStatus());
});

export const adminReadRouter = Router();
adminReadRouter.use(requireAdminRead);

export const reportsRouter = Router();
reportsRouter.use(requireReportsAccess);

const ROLES = ['alliance_admin', 'admin', 'full', 'edit', 'readonly'] as const;
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
      const r = await esiFetch(`https://esi.evetech.net/v5/corporations/${id}/`);
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
      const r = await esiFetch(`https://esi.evetech.net/v3/alliances/${id}/`);
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
    lastKnownSystemId:   number | null;
    lastKnownSystemName: string | null;
    lastKnownSystemAt:   string | null;
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
      u.last_login_at  AS "lastLogin",
      COALESCE(e.cnt, 0) AS "totalEvents",
      COALESCE(s.cnt, 0) AS "totalSignatures",
      u.last_known_system_id AS "lastKnownSystemId",
      lks.name               AS "lastKnownSystemName",
      u.last_known_system_at AS "lastKnownSystemAt"
    FROM users u
    LEFT JOIN solar_systems lks ON lks.id = u.last_known_system_id
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS cnt FROM user_events GROUP BY user_id
    ) e ON e.user_id = u.id
    LEFT JOIN (
      SELECT m.user_id, COUNT(*)::int AS cnt
      FROM reportable_signatures ms
      JOIN map_systems sys ON sys.id = ms.system_id
      JOIN maps m          ON m.id  = sys.map_id
      GROUP BY m.user_id
    ) s ON s.user_id = u.id
    ORDER BY u.last_login_at DESC NULLS LAST
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

  const actorRole = req.session.role ?? 'readonly';
  const newRoleReq = role as Role;

  // Block self-demote — an admin removing their own admin role mid-session
  // would lock themselves out unless another admin exists. Forcing them to
  // go through another admin avoids accidental lockout. (alliance_admin ->
  // admin is not a lockout, so it's allowed.)
  if (userId === req.session.userId && !isAdmin(newRoleReq)) {
    res.status(400).json({ error: 'You cannot demote yourself' });
    return;
  }

  const targetRows = await db.query<{ character_id: number; role: string }>(
    `SELECT character_id, role FROM users WHERE id = $1`,
    [userId],
  );
  if (!targetRows.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = targetRows.rows[0];

  // Privilege-escalation guard: only an alliance admin can grant the
  // alliance_admin role or alter someone who already holds it. Stops a corp
  // admin from minting an alliance admin (themselves or anyone else).
  if ((newRoleReq === 'alliance_admin' || target.role === 'alliance_admin') && !isAllianceAdmin(actorRole)) {
    res.status(403).json({ error: 'Only an alliance admin can manage the alliance admin role' });
    return;
  }

  // The configured ADMIN_CHAR_ID is auto-promoted on every login, so demoting
  // them below admin here just creates confusing churn next login.
  if (config.adminCharId !== null && target.character_id === config.adminCharId && !isAdmin(newRoleReq)) {
    res.status(400).json({ error: 'Cannot demote the configured ADMIN_CHAR_ID' });
    return;
  }

  if (target.role === role) { res.json({ ok: true, unchanged: true }); return; }

  const newRole = role as Role;
  await db.query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [newRole, userId]);
  await audit(req, userId, target.character_id, 'role_change', target.role, newRole);
  // A live session carries a login-time role snapshot; drop the user's sessions so
  // the change takes effect immediately (a demotion otherwise keeps its old map
  // write access until re-login / the 7-day cookie TTL). Matches the block handler.
  await invalidateSessionsForUser(userId);

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

  const { rows } = await db.query<{ character_id: number; blocked: boolean; role: string }>(
    `SELECT character_id, blocked, role FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = rows[0];

  // An alliance admin can only be blocked by another alliance admin — a corp
  // admin must not be able to lock one out.
  if (target.role === 'alliance_admin' && !isAllianceAdmin(req.session.role ?? 'readonly')) {
    res.status(403).json({ error: 'Only an alliance admin can block an alliance admin' });
    return;
  }

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
    const r = await esiFetch(`https://esi.evetech.net/v4/characters/${target.character_id}/`);
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

// ── Login allow-list (access_grants) ─────────────────────────────────────────
// Who may sign in beyond the .env core. .env rows (source='env') are immutable
// here. Every non-env grant must clear the positive-standing prerequisite
// (design 4.0). See access-control-design.md.

// GET /api/admin/access-grants — list all grants with resolved names.
adminRouter.get('/access-grants', async (_req, res) => {
  const { rows } = await db.query<{
    id: string; kind: GrantKind; eve_id: string; source: string;
    note: string | null; created_at: string; added_by_name: string | null;
  }>(
    `SELECT g.id, g.kind, g.eve_id, g.source, g.note, g.created_at,
            u.character_name AS added_by_name
       FROM access_grants g
       LEFT JOIN users u ON u.id = g.added_by_user
      ORDER BY g.kind, g.created_at`,
  );
  // eve_id is BIGINT — node-pg hands it back as a string, which the ESI/name
  // resolvers (they filter on Number.isInteger) and the Map lookups reject.
  // Normalise to a number once. EVE ids fit safely in a JS number.
  const eid = (r: { eve_id: string }) => Number(r.eve_id);
  const [corps, alliances, names] = await Promise.all([
    resolveCorps(rows.filter((r) => r.kind === 'corp').map(eid)),
    resolveAlliances(rows.filter((r) => r.kind === 'alliance').map(eid)),
    resolveEntityNames(rows.filter((r) => r.kind === 'character').map(eid)),
  ]);
  const label = (r: { kind: GrantKind; eve_id: string }): string => {
    const id = eid(r);
    if (r.kind === 'corp')     { const c = corps.get(id);     return c ? `${c.name} [${c.ticker}]` : String(id); }
    if (r.kind === 'alliance') { const a = alliances.get(id); return a ? `${a.name} [${a.ticker}]` : String(id); }
    return names.get(id)?.name ?? String(id);
  };
  res.json(rows.map((r) => ({
    id: r.id, kind: r.kind, eveId: eid(r), source: r.source, note: r.note,
    addedByName: r.added_by_name, createdAt: r.created_at,
    label: label(r), immutable: r.source === 'env',
  })));
});

// GET /api/admin/standings-view — the deployment's OWN contact list (the corp's
// contacts in a corp install, the alliance's in an alliance install), limited to
// corporation + alliance contacts and resolved to name + ticker + standing. Feeds
// the access-page standings viewer. Read-only; access control itself only ever
// reads these same corp/alliance buckets. See access-control-design.md.
adminRouter.get('/standings-view', async (_req, res) => {
  interface Contact { contactKind: 'corporation' | 'alliance'; id: number; name: string; ticker: string | null; standing: number }

  async function loadContacts(table: 'corp_standings' | 'alliance_standings', ownerCol: 'corp_id' | 'alliance_id', ownerIds: number[]): Promise<Contact[]> {
    if (ownerIds.length === 0) return [];
    // MAX(standing): with multiple deployment owner ids the gate admits on the
    // best standing toward a contact, so surface that same effective value.
    const { rows } = await db.query<{ contact_kind: 'corporation' | 'alliance'; contact_id: string; standing: number }>(
      `SELECT contact_kind, contact_id, MAX(standing)::real AS standing
         FROM ${table}
        WHERE ${ownerCol} = ANY($1::bigint[])
          AND contact_kind IN ('corporation', 'alliance')
        GROUP BY contact_kind, contact_id`,
      [ownerIds],
    );
    const corpIds = rows.filter((r) => r.contact_kind === 'corporation').map((r) => Number(r.contact_id));
    const allyIds = rows.filter((r) => r.contact_kind === 'alliance').map((r) => Number(r.contact_id));
    const [corps, alliances] = await Promise.all([resolveCorps(corpIds), resolveAlliances(allyIds)]);
    return rows.map((r) => {
      const id   = Number(r.contact_id);
      const info = r.contact_kind === 'corporation' ? corps.get(id) : alliances.get(id);
      return { contactKind: r.contact_kind, id, name: info?.name ?? String(id), ticker: info?.ticker ?? null, standing: r.standing };
    });
  }

  const [corp, alliance] = await Promise.all([
    config.corpMode     ? loadContacts('corp_standings',     'corp_id',     config.corpIds)     : Promise.resolve(null),
    config.allianceMode ? loadContacts('alliance_standings', 'alliance_id', config.allianceIds) : Promise.resolve(null),
  ]);
  res.json({ corp, alliance });
});

// POST /api/admin/access-grants — add a corp/alliance/character to the allow-list.
adminRouter.post('/access-grants', async (req, res) => {
  const kind = req.body?.kind as GrantKind;
  const eveId = parseInt(String(req.body?.eveId), 10);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) || null : null;

  if (kind !== 'corp' && kind !== 'alliance' && kind !== 'character') {
    res.status(400).json({ error: 'kind must be corp, alliance, or character' }); return;
  }
  if (!Number.isInteger(eveId) || eveId <= 0) {
    res.status(400).json({ error: 'invalid eveId' }); return;
  }
  // Alliance grants are alliance-install-only (a corp install ignores alliance
  // standings, so an alliance target could never clear the positive gate).
  if (!grantKindAllowedForInstall(kind)) {
    res.status(400).json({ error: 'alliance_not_supported', message: 'Alliance grants are only available on an alliance installation.' }); return;
  }
  // Positive-standing prerequisite (design 4.0): corp/alliance targets must be
  // held at positive standing; individual characters are exempt (deliberate 1:1
  // grant). Fail-closed for the group kinds.
  if (requiresPositiveStanding(kind) && !(await standingPermitsTarget(kind, eveId))) {
    res.status(403).json({ error: 'standing_not_positive', message: 'The deployment does not hold this entity at positive standing (contacts must be synced and standing must be > 0).' }); return;
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO access_grants (kind, eve_id, source, note, added_by_user)
     VALUES ($1, $2, 'admin', $3, $4)
     ON CONFLICT (kind, eve_id) DO NOTHING
     RETURNING id`,
    [kind, eveId, note, req.session.userId ?? null],
  );
  if (!rows.length) { res.status(409).json({ error: 'already_granted' }); return; }
  await audit(req, null, kind === 'character' ? eveId : null, 'access_grant_add', null, `${kind}:${eveId}`);
  res.status(201).json({ ok: true, id: rows[0].id });
});

// DELETE /api/admin/access-grants/:id — revoke a grant. env rows are immutable.
// Kills the sessions of anyone this grant was the sole reason for admitting.
adminRouter.delete('/access-grants/:id', async (req, res) => {
  const { rows } = await db.query<{ kind: GrantKind; eve_id: number; source: string }>(
    `SELECT kind, eve_id, source FROM access_grants WHERE id = $1`, [req.params.id],
  );
  if (!rows.length) { res.status(404).json({ error: 'not found' }); return; }
  const g = rows[0];
  if (g.source === 'env') {
    res.status(400).json({ error: 'env_immutable', message: 'This grant is seeded from .env and can only be removed by editing .env.' }); return;
  }

  await db.query(`DELETE FROM access_grants WHERE id = $1`, [req.params.id]);
  await audit(req, null, g.kind === 'character' ? g.eve_id : null, 'access_grant_remove', `${g.kind}:${g.eve_id}`, null);

  // Immediately log out anyone the gate no longer permits. Reuse the shared
  // re-validation so the check matches the login gate exactly: it evaluates
  // isLoginPermitted OR standingsPermitLogin, so a user still admitted via the
  // standings auto-admit isn't spuriously logged out just because this explicit
  // grant was removed. Never evicts ADMIN_CHAR_ID.
  const { sessionsKilled } = await revalidateActiveSessions();
  res.json({ ok: true, sessionsKilled });
});

// ── Standings auto-admit ("friends") settings — Phase 3 ──────────────────────

// GET /api/admin/access-settings — current standings auto-admit toggle + level.
adminRouter.get('/access-settings', async (_req, res) => {
  const s = await getStandingsLoginSettings();
  res.json({ standingsLoginEnabled: s.enabled, standingsLoginThreshold: s.threshold });
});

// PATCH /api/admin/access-settings — update the standings auto-admit settings.
adminRouter.patch('/access-settings', async (req, res) => {
  const { enabled, threshold } = req.body as { enabled?: unknown; threshold?: unknown };
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
    await setSetting(STANDINGS_LOGIN_ENABLED, enabled ? 'true' : 'false', req.session.userId ?? null);
  }
  if (threshold !== undefined) {
    if (threshold !== 5 && threshold !== 10) { res.status(400).json({ error: 'threshold must be 5 or 10' }); return; }
    await setSetting(STANDINGS_LOGIN_THRESHOLD, String(threshold), req.session.userId ?? null);
  }
  await audit(req, null, null, 'access_settings_update', null, JSON.stringify({ enabled, threshold }));
  // A settings change can NARROW who's admitted (disabling, or raising the
  // threshold), so immediately evict any live session the new gate no longer
  // permits — otherwise a de-authorised user lingers to the cookie TTL.
  // Widening changes evict nobody, so it's safe to always run.
  const { sessionsKilled } = await revalidateActiveSessions();
  const s = await getStandingsLoginSettings();
  res.json({ standingsLoginEnabled: s.enabled, standingsLoginThreshold: s.threshold, sessionsKilled });
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

// ── Discord notification settings ─────────────────────────────────────────────
// Region filter + per-event-type toggles + per-map exclusions for the Discord
// webhook notifications. Scoped to the admin's own org — corp OR alliance. An
// alliance deployment's admin (alliance_admin) manages the alliance's settings;
// otherwise the admin's corp. See discord_filters_feature.md.

type DiscordScope = { kind: 'corp' | 'alliance'; id: number };

// Which org's Discord settings this admin manages. Alliance takes precedence in
// an alliance-mode deployment when the caller is an alliance admin; otherwise
// the caller's corp. null when the caller has no org (personal deployment).
function resolveDiscordScope(req: Request): DiscordScope | null {
  const role       = req.session.role ?? 'readonly';
  const allianceId = req.session.userAllianceId ?? null;
  const corpId     = req.session.userCorpId ?? null;
  if (config.allianceMode && allianceId != null && isAllianceAdmin(role)) return { kind: 'alliance', id: allianceId };
  if (corpId != null) return { kind: 'corp', id: corpId };
  return null;
}

// Vocab for the wormhole notification filters. Classes/sizes are validated
// against these; type codes are validated by shape (letter + 3 digits, incl.
// K162) since the catalog is dynamic.
const WH_CLASSES = new Set(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'HS', 'LS', 'NS', 'Thera', 'Pochven', 'Drifter', 'Turnur']);
const WH_SIZES   = new Set(['small', 'medium', 'large', 'xl']);
const WH_TYPE_RE = /^[A-Z][0-9]{3}$/;

interface WhSettingsRow {
  allRegions: boolean; regions: string[]; notifyChains: boolean;
  whTypes: string[]; whClasses: string[]; whSizes: string[];
  connectionsWebhook: string | null; chainsWebhook: string | null;
  exitsMinSecurity: number;
}
const WH_SETTINGS_COLS = `all_regions AS "allRegions", regions, notify_chains AS "notifyChains",
                          wh_types AS "whTypes", wh_classes AS "whClasses", wh_sizes AS "whSizes",
                          connections_webhook AS "connectionsWebhook", chains_webhook AS "chainsWebhook",
                          exits_min_security AS "exitsMinSecurity"`;

// GET /api/admin/discord — current settings + this org's maps with their
// excluded state (excluded = NOT discord_notify).
adminRouter.get('/discord', async (req, res) => {
  const scope = resolveDiscordScope(req);
  if (!scope) {
    res.json({ scope: null, allRegions: true, regions: [], notifyChains: true, whTypes: [], whClasses: [], whSizes: [], connectionsWebhook: '', chainsWebhook: '', exitsMinSecurity: 0.45, maps: [] });
    return;
  }
  // Literal SQL per branch (no interpolated identifiers) so the settings table /
  // scope column are never string-built from a variable.
  const settingsP = scope.kind === 'alliance'
    ? db.query<WhSettingsRow>(`SELECT ${WH_SETTINGS_COLS} FROM alliance_discord_settings WHERE alliance_id = $1`, [scope.id])
    : db.query<WhSettingsRow>(`SELECT ${WH_SETTINGS_COLS} FROM corp_discord_settings WHERE corp_id = $1`, [scope.id]);
  const mapsP = scope.kind === 'alliance'
    ? db.query<{ id: string; name: string; excluded: boolean }>(
        `SELECT id, name, NOT discord_notify AS excluded FROM maps WHERE alliance_id = $1 ORDER BY name`, [scope.id])
    : db.query<{ id: string; name: string; excluded: boolean }>(
        `SELECT id, name, NOT discord_notify AS excluded FROM maps WHERE corp_id = $1 ORDER BY name`, [scope.id]);
  const [settings, maps] = await Promise.all([settingsP, mapsP]);
  const row = settings.rows[0];
  res.json({
    scope:        scope.kind,
    allRegions:   row?.allRegions ?? true,
    regions:      row?.regions ?? [],
    notifyChains: row?.notifyChains ?? true,
    whTypes:      row?.whTypes ?? [],
    whClasses:    row?.whClasses ?? [],
    whSizes:      row?.whSizes ?? [],
    connectionsWebhook: row?.connectionsWebhook ?? '',
    chainsWebhook:      row?.chainsWebhook ?? '',
    exitsMinSecurity:   row?.exitsMinSecurity ?? 0.45,
    maps:         maps.rows,
  });
});

// PUT /api/admin/discord — set the region filter + event toggles for the org.
adminRouter.put('/discord', async (req, res) => {
  const scope = resolveDiscordScope(req);
  if (!scope) { res.status(400).json({ error: 'No org context' }); return; }

  const body = req.body as {
    allRegions?: unknown; regions?: unknown; notifyChains?: unknown;
    whTypes?: unknown; whClasses?: unknown; whSizes?: unknown;
    connectionsWebhook?: unknown; chainsWebhook?: unknown; exitsMinSecurity?: unknown;
  };
  const allRegions   = body.allRegions !== false;   // default true
  const notifyChains = body.notifyChains !== false; // default true

  // Minimum k-space exit security for the rich exit embed. A finite number
  // clamped to EVE's [-1.0, 1.0] range; default 0.45 (high-sec) when absent or
  // invalid. Not a secret — always written (no webhook-style masking).
  const exitsMinSecurity = typeof body.exitsMinSecurity === 'number' && Number.isFinite(body.exitsMinSecurity)
    ? Math.min(1.0, Math.max(-1.0, body.exitsMinSecurity))
    : 0.45;

  // Webhook URLs. A field that's PRESENT sets the value: empty string clears
  // (NULL), a non-empty value MUST be a real Discord webhook (SSRF guard) or the
  // whole request is rejected. A field that's ABSENT leaves the stored value
  // unchanged (so a partial PUT — e.g. a future API client that doesn't know
  // about webhooks — can't wipe them). `provided` distinguishes the two.
  const resolveWebhook = (v: unknown): { provided: boolean; value: string | null; bad: boolean } => {
    if (typeof v !== 'string') return { provided: false, value: null, bad: false };
    const s = v.trim();
    if (s === '') return { provided: true, value: null, bad: false };
    return isDiscordWebhookUrl(s) ? { provided: true, value: s, bad: false } : { provided: true, value: null, bad: true };
  };
  const conn  = resolveWebhook(body.connectionsWebhook);
  const chain = resolveWebhook(body.chainsWebhook);
  if (conn.bad || chain.bad) {
    res.status(400).json({ error: 'Webhook must be a Discord webhook URL (https://discord.com/api/webhooks/…)' });
    return;
  }
  let regions = Array.isArray(body.regions)
    ? body.regions.filter((r): r is string => typeof r === 'string')
    : [];

  // Validate region names against the known region list (drop anything bogus).
  if (regions.length) {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM map_regions WHERE name = ANY($1::text[])`, [regions],
    );
    const valid = new Set(rows.map((r) => r.name));
    regions = [...new Set(regions.filter((r) => valid.has(r)))];
  }

  // Wormhole filters — empty array = "all". Sanitise against the known vocab so a
  // bogus code/class/size can never be stored (or later matched against).
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const whTypes   = [...new Set(asStrings(body.whTypes).map((s) => s.trim().toUpperCase()).filter((s) => WH_TYPE_RE.test(s)))];
  const whClasses = [...new Set(asStrings(body.whClasses).map((s) => s.trim()).filter((s) => WH_CLASSES.has(s)))];
  const whSizes   = [...new Set(asStrings(body.whSizes).map((s) => s.trim().toLowerCase()).filter((s) => WH_SIZES.has(s)))];

  // On an existing row, only overwrite a webhook column when the field was
  // provided (CASE on the `provided` flag); otherwise keep the stored value.
  const params = [scope.id, allRegions, regions, notifyChains, whTypes, whClasses, whSizes, conn.value, chain.value, conn.provided, chain.provided, exitsMinSecurity];
  if (scope.kind === 'alliance') {
    await db.query(
      `INSERT INTO alliance_discord_settings (alliance_id, all_regions, regions, notify_chains, wh_types, wh_classes, wh_sizes, connections_webhook, chains_webhook, exits_min_security, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, NOW())
       ON CONFLICT (alliance_id) DO UPDATE
         SET all_regions = EXCLUDED.all_regions, regions = EXCLUDED.regions,
             notify_chains = EXCLUDED.notify_chains, wh_types = EXCLUDED.wh_types,
             wh_classes = EXCLUDED.wh_classes, wh_sizes = EXCLUDED.wh_sizes,
             connections_webhook = CASE WHEN $10 THEN EXCLUDED.connections_webhook ELSE alliance_discord_settings.connections_webhook END,
             chains_webhook      = CASE WHEN $11 THEN EXCLUDED.chains_webhook      ELSE alliance_discord_settings.chains_webhook END,
             exits_min_security = EXCLUDED.exits_min_security,
             updated_at = NOW()`,
      params,
    );
  } else {
    await db.query(
      `INSERT INTO corp_discord_settings (corp_id, all_regions, regions, notify_chains, wh_types, wh_classes, wh_sizes, connections_webhook, chains_webhook, exits_min_security, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, NOW())
       ON CONFLICT (corp_id) DO UPDATE
         SET all_regions = EXCLUDED.all_regions, regions = EXCLUDED.regions,
             notify_chains = EXCLUDED.notify_chains, wh_types = EXCLUDED.wh_types,
             wh_classes = EXCLUDED.wh_classes, wh_sizes = EXCLUDED.wh_sizes,
             connections_webhook = CASE WHEN $10 THEN EXCLUDED.connections_webhook ELSE corp_discord_settings.connections_webhook END,
             chains_webhook      = CASE WHEN $11 THEN EXCLUDED.chains_webhook      ELSE corp_discord_settings.chains_webhook END,
             exits_min_security = EXCLUDED.exits_min_security,
             updated_at = NOW()`,
      params,
    );
  }
  res.json({ ok: true, allRegions, regions, notifyChains, whTypes, whClasses, whSizes, exitsMinSecurity });
});

// PATCH /api/admin/maps/:id/discord — exclude / re-include one of the org's
// maps from Discord notifications. Maps notify by default, so this manages the
// exceptions. Scoped to the admin's org so an admin can't toggle another org's map.
adminRouter.patch('/maps/:id/discord', async (req, res) => {
  const mapId = req.params.id;
  const scope = resolveDiscordScope(req);
  if (!mapId) { res.status(400).json({ error: 'invalid map id' }); return; }
  if (!scope) { res.status(400).json({ error: 'No org context' }); return; }
  const excluded = (req.body as { excluded?: unknown }).excluded === true;

  const { rowCount } = scope.kind === 'alliance'
    ? await db.query(
        `UPDATE maps SET discord_notify = $1, updated_at = NOW() WHERE id = $2 AND alliance_id = $3`,
        [!excluded, mapId, scope.id])
    : await db.query(
        `UPDATE maps SET discord_notify = $1, updated_at = NOW() WHERE id = $2 AND corp_id = $3`,
        [!excluded, mapId, scope.id]);
  if (!rowCount) { res.status(404).json({ error: 'Map not found' }); return; }
  res.json({ ok: true, excluded });
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
  // Admins additionally only see users in their scope; reports char sees all.
  // An alliance admin scopes by alliance (matching corpScopeFor's map filter),
  // a corp admin by corp — otherwise the alliance id would be tested against
  // u.corp_id and match nobody.
  const userScope = scope.param !== null
    ? (req.session.role === 'alliance_admin' ? `u.alliance_id = $1` : `u.corp_id = $1`)
    : null;

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
        SELECT 1 FROM reportable_signatures s
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
        SELECT 1 FROM reportable_signatures s
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
      FROM reportable_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} AND s.created_by_user_id IS NOT NULL
      GROUP BY s.created_by_user_id
    ),
    -- "Last active" = the most recent time a user did something of value on a
    -- corp map: added or edited a signature, anomaly, or structure. Combined
    -- with the user's last system-to-system move (last_known_system_at) in the
    -- SELECT below. GREATEST(created_at, updated_at) per row catches edits, not
    -- just the original add.
    last_active AS (
      SELECT user_id, MAX(ts) AS ts FROM (
        SELECT s.created_by_user_id AS user_id, GREATEST(s.created_at, s.updated_at) AS ts
          FROM reportable_signatures s
          JOIN map_systems sys ON sys.id = s.system_id
          JOIN maps         m  ON m.id   = sys.map_id
          WHERE ${corpSql} AND s.created_by_user_id IS NOT NULL
        UNION ALL
        SELECT a.created_by_user_id, GREATEST(a.created_at, a.updated_at)
          FROM map_anomalies a
          JOIN map_systems sys ON sys.id = a.system_id
          JOIN maps         m  ON m.id   = sys.map_id
          WHERE ${corpSql} AND a.created_by_user_id IS NOT NULL
        UNION ALL
        SELECT st.created_by_user_id, GREATEST(st.created_at, st.updated_at)
          FROM map_structures st
          JOIN map_systems sys ON sys.id = st.system_id
          JOIN maps         m  ON m.id   = sys.map_id
          WHERE ${corpSql} AND st.created_by_user_id IS NOT NULL
      ) acts
      GROUP BY user_id
    ),
    sig_breakdown AS (
      -- Count live signatures (not the historical event log) so deletions
      -- are reflected. corp scope applies via the maps join so an admin
      -- viewing the report only sees activity on their corp's maps.
      SELECT s.created_by_user_id AS user_id, s.sig_type, COUNT(*)::int AS cnt
      FROM reportable_signatures s
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
      u.last_login_at  AS "lastLogin",
      u.last_known_system_id AS "lastKnownSystemId",
      lks.name               AS "lastKnownSystemName",
      lcs.ts           AS "lastCorpSigAt",
      GREATEST(la.ts, u.last_known_system_at) AS "lastActive",
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
    LEFT JOIN solar_systems    lks  ON lks.id       = u.last_known_system_id
    LEFT JOIN last_corp_sig    lcs  ON lcs.user_id  = u.id
    LEFT JOIN last_active      la   ON la.user_id   = u.id
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
      FROM reportable_signatures s
      JOIN map_systems sys ON sys.id = s.system_id
      JOIN maps         m  ON m.id   = sys.map_id
      WHERE ${corpSql} ${windowClause}
      GROUP BY s.sig_type
    `, buildBase(windowParams)),
    db.query<{ wh_type: string; cnt: number }>(`
      SELECT UPPER(s.wh_type) AS wh_type, COUNT(*)::int AS cnt
      FROM reportable_signatures s
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
      FROM reportable_signatures s
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
        FROM reportable_signatures s
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
        FROM reportable_signatures s
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
        FROM reportable_signatures s
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
