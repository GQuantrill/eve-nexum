import type { Request, Response, NextFunction } from 'express';
import { db } from '../db.js';
import { isAdmin, type Role } from './authContext.js';

const KNOWN_ROLES = new Set<Role>(['alliance_admin', 'admin', 'full', 'edit', 'readonly']);

// Re-verifies admin role against the DB on every call so a freshly-demoted
// admin can't keep using their old session. The session field is kept in
// sync as a side effect. Alliance admins inherit every admin capability.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM users WHERE id = $1`,
    [req.session.userId],
  );
  const role = rows[0]?.role as Role | undefined;
  if (!role || !KNOWN_ROLES.has(role)) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  req.session.role = role;
  if (!isAdmin(role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
