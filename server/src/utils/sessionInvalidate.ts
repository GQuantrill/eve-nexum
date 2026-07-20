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

/**
 * Refresh the corp/alliance affiliation carried in a user's LIVE sessions,
 * in place, without evicting them. The session stores a login-time snapshot of
 * userCorpId/userAllianceId that map read/write scope reads; when the periodic
 * revalidation adopts a fresh affiliation from ESI (a pilot changed corp) but
 * the user is still permitted, this keeps their session but updates its scope so
 * they immediately see/edit the right corp's maps — rather than the old corp's
 * until the 7-day cookie expires. Deliberately does NOT drop the session (the
 * design keeps sessions across corp moves).
 *
 * The `sess` column is JSON; we cast to jsonb to set the keys, then back.
 * Returns the number of sessions updated (0 if none / no table yet).
 */
export async function refreshSessionAffiliation(
  userId: number, corpId: number | null, allianceId: number | null,
): Promise<number> {
  try {
    const { rowCount } = await db.query(
      // COALESCE to the jsonb 'null' literal: a bare to_jsonb(NULL::int) is SQL
      // NULL, and jsonb_set(..., NULL) returns NULL — which would blow away the
      // whole session (sess is NOT NULL). We want the JSON value null instead.
      `UPDATE sessions
          SET sess = jsonb_set(
                       jsonb_set(sess::jsonb, '{userCorpId}',     COALESCE(to_jsonb($2::int), 'null'::jsonb)),
                       '{userAllianceId}', COALESCE(to_jsonb($3::int), 'null'::jsonb)
                     )::json
        WHERE sess->>'userId' = $1`,
      [String(userId), corpId, allianceId],
    );
    return rowCount ?? 0;
  } catch (err) {
    log.warn('refreshSessionAffiliation failed:', err);
    return 0;
  }
}
