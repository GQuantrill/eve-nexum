import { db } from '../db.js';
import { createLogger } from './logger.js';

const log = createLogger('sessions');

/**
 * Delete every active session belonging to a given user from the
 * connect-pg-simple session store. Used when an admin blocks a user (or
 * the corp-departure auto-block fires) so existing tabs can't continue
 * mutating data with a stale cookie until they happen to log out.
 *
 * The `sess` column is JSON; `->>` works on both JSON and JSONB. userId
 * is stored as a number in the session, but the `->>` operator always
 * returns text, so we compare against the string form.
 *
 * Safe to call when the user has no sessions — returns 0.
 */
export async function invalidateSessionsForUser(userId: number): Promise<number> {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM sessions WHERE sess->>'userId' = $1`,
      [String(userId)],
    );
    return rowCount ?? 0;
  } catch (err) {
    // The sessions table is created lazily on first request, so a brand-new
    // deployment with no logins yet won't have it. Swallow that and report 0
    // — there's nothing to invalidate.
    log.warn('invalidateSessionsForUser failed:', err);
    return 0;
  }
}
