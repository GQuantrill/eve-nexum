import type { Request, Response, NextFunction } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { isAdmin, type Role } from './authContext.js';

const KNOWN_ROLES = new Set<Role>(['alliance_admin', 'admin', 'full', 'edit', 'readonly']);

export async function requireAdminRead(req: Request, res: Response, next: NextFunction) {
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

  const allowed = isAdmin(role)
    || (config.reportsCharId !== null && req.session.characterId === config.reportsCharId);
  if (!allowed) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
