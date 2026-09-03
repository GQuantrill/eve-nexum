import { db } from '../db.js';
import type { Request } from 'express';
import { resolveOwnerId } from '../utils/owner.js';

/**
 * The one thing a 'contributor' may do to a map's shape: record their own
 * movement. They cannot add a system by hand — not from the right-click menu,
 * not via "add adjacent" — and they cannot draw, edit or delete connections.
 *
 * The difference between "I jumped here" and "I clicked here" can't be taken on
 * the client's word: a flag in the request body is trivially forged. So it's
 * verified against where the character actually IS, which the location poll
 * writes to users.last_known_system_id before the client is ever told it moved.
 * A tracked add therefore always matches; a right-click on some other system
 * never does.
 *
 * Checked across the whole account, not just the session character: a tab can be
 * pinned to an alt (routeOrigin), so the pilot doing the moving may not be the
 * one the session is bound to.
 */
export async function contributorIsAtSystem(req: Request, eveSystemId: number): Promise<boolean> {
  if (!Number.isInteger(eveSystemId) || eveSystemId <= 0) return false;
  const userId = req.session.userId;
  if (!userId) return false;
  const ownerId = await resolveOwnerId(req);
  const { rowCount } = await db.query(
    `SELECT 1 FROM users
      WHERE last_known_system_id = $1
        AND (id = $2 OR ($3::int IS NOT NULL AND owner_id = $3))
      LIMIT 1`,
    [eveSystemId, userId, ownerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * True when one END of a proposed connection is where the caller actually is —
 * i.e. it's the link their own jump just made. Either endpoint counts: the map
 * node for the system they arrived in is created moments before the connection,
 * and which of source/target it lands on depends on the direction of travel.
 */
export async function contributorMayLinkSystems(
  req: Request, sourceMapSystemId: string, targetMapSystemId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ eve: number | null }>(
    `SELECT eve_system_id AS eve FROM map_systems WHERE id = ANY($1::uuid[])`,
    [[sourceMapSystemId, targetMapSystemId]],
  );
  for (const r of rows) {
    if (r.eve != null && await contributorIsAtSystem(req, r.eve)) return true;
  }
  return false;
}
