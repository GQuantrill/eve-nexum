import type { Request } from 'express';
import { db } from '../db.js';

/**
 * The account (owner) id for the current session. Cached on the session by
 * login / the auth routes; lazily backfilled from the DB here for sessions
 * that predate multi-account support. Returns null only if not authenticated.
 */
export async function resolveOwnerId(req: Request): Promise<number | null> {
  if (req.session.ownerId != null) return req.session.ownerId;
  if (!req.session.userId) return null;
  const { rows } = await db.query<{ owner_id: number | null }>(
    `SELECT owner_id FROM users WHERE id = $1`, [req.session.userId],
  );
  const oid = rows[0]?.owner_id ?? null;
  if (oid != null) req.session.ownerId = oid;
  return oid;
}
