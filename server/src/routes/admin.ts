import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { config } from '../config.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/users — all users with activity stats
adminRouter.get('/users', async (_req, res) => {
  // Two pre-aggregated subqueries joined into users — avoids the cartesian
  // explosion (COUNT(DISTINCT) over a triple-nested IN) the previous version
  // produced for users with many maps and many signatures.
  const { rows } = await db.query(`
    SELECT
      u.id,
      u.character_id   AS "characterId",
      u.character_name AS "characterName",
      u.role,
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
  res.json({ users: rows });
});

// PATCH /api/admin/users/:id/role
adminRouter.patch('/users/:id/role', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body as { role?: string };

  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid user id' });
    return;
  }
  if (role !== 'admin' && role !== 'member' && role !== 'readonly') {
    res.status(400).json({ error: 'role must be admin, member, or readonly' });
    return;
  }

  // Block self-demote — an admin removing their own admin role mid-session
  // would lock themselves out unless another admin exists. Forcing them to
  // go through another admin avoids accidental lockout.
  if (userId === req.session.userId && role !== 'admin') {
    res.status(400).json({ error: 'You cannot demote yourself' });
    return;
  }

  // Look up the target row up-front so we can both block ADMIN_CHAR_ID demote
  // and capture the previous role for the audit log in one DB roundtrip.
  const targetRows = await db.query<{ character_id: number; role: string }>(
    `SELECT character_id, role FROM users WHERE id = $1`,
    [userId],
  );
  if (!targetRows.rows.length) { res.status(404).json({ error: 'User not found' }); return; }
  const target = targetRows.rows[0];

  // The configured ADMIN_CHAR_ID is auto-promoted to admin on every login
  // (see auth.ts), so demoting them here just creates confusing churn the
  // next time they log in. Reject and surface why.
  if (config.adminCharId !== null && target.character_id === config.adminCharId && role !== 'admin') {
    res.status(400).json({ error: 'Cannot demote the configured ADMIN_CHAR_ID' });
    return;
  }

  if (target.role === role) { res.json({ ok: true, unchanged: true }); return; }

  await db.query(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
    [role, userId],
  );

  await db.query(
    `INSERT INTO admin_audit
       (actor_user_id, actor_character_id, target_user_id, target_character_id, action, old_value, new_value)
     VALUES ($1, $2, $3, $4, 'role_change', $5, $6)`,
    [req.session.userId, req.session.characterId, userId, target.character_id, target.role, role],
  );

  res.json({ ok: true });
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
