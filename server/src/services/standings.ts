import { db } from '../db.js';
import { SCOPE, hasScope } from '../utils/esiScopes.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('standings');

// Refresh standings at most once every 6 hours per owner. Corp / alliance
// contact lists are typically edited a few times a month, so a 6-hour TTL
// keeps the data fresh enough for ops decisions without re-fetching on
// every login. ESI's own contacts cache is 5 minutes; anything faster
// here just makes the server work harder for no fresher data.
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

// ── Corp/alliance contact-bucket read cache ──────────────────────────────────
// The corp/alliance buckets are shared across every member and change only on a
// member's sync, but /api/standings/me is hit per map load/poll by every
// member — a big corp's thousands of contacts would otherwise be re-queried and
// re-materialised for each member on each poll. Cache them briefly, keyed by
// kind:id, invalidated on write (below) so a fresh sync is seen at once; the TTL
// bounds staleness for any write path that forgets to invalidate.
export type OrgContactRow = { contact_kind: string; contact_id: number; standing: number };
const CONTACT_TTL_MS = 60_000;
const orgContactCache = new Map<string, { rows: OrgContactRow[]; at: number }>();

export async function loadOrgContacts(kind: 'corp' | 'alliance', id: number): Promise<OrgContactRow[]> {
  const key = `${kind}:${id}`;
  const hit = orgContactCache.get(key);
  if (hit && Date.now() - hit.at < CONTACT_TTL_MS) return hit.rows;
  const sql = kind === 'corp'
    ? `SELECT contact_kind, contact_id, standing FROM corp_standings WHERE corp_id = $1`
    : `SELECT contact_kind, contact_id, standing FROM alliance_standings WHERE alliance_id = $1`;
  const { rows } = await db.query<OrgContactRow>(sql, [id]);
  orgContactCache.set(key, { rows, at: Date.now() });
  return rows;
}

function invalidateOrgContacts(kind: 'corp' | 'alliance', id: number): void {
  orgContactCache.delete(`${kind}:${id}`);
}

type ContactKind = 'character' | 'corporation' | 'alliance' | 'faction';

interface EsiContact {
  contact_id:   number;
  contact_type: ContactKind;
  standing:     number;
}

async function fetchAllContacts(url: string, token: string): Promise<EsiContact[] | { error: 'forbidden' | 'unauthorized' | 'other'; status: number }> {
  const all: EsiContact[] = [];
  let page = 1;
  while (true) {
    const r = await esiFetch(`${url}?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 403) return { error: 'forbidden',    status: 403 };
    if (r.status === 401) return { error: 'unauthorized', status: 401 };
    if (!r.ok)            return { error: 'other',        status: r.status };
    const batch = await r.json() as EsiContact[];
    all.push(...batch);
    const pages = parseInt(r.headers.get('x-pages') ?? '1', 10);
    if (page >= pages) break;
    page += 1;
    if (page > 50) break; // safety: bail on absurd alliance sizes
  }
  return all;
}

async function shouldRefresh(ownerKind: string, ownerId: number): Promise<boolean> {
  const { rows } = await db.query<{ last_fetched_at: string }>(
    `SELECT last_fetched_at FROM standings_refresh WHERE owner_kind = $1 AND owner_id = $2`,
    [ownerKind, ownerId],
  );
  if (!rows.length) return true;
  return Date.now() - new Date(rows[0].last_fetched_at).getTime() > REFRESH_TTL_MS;
}

async function markRefreshed(ownerKind: string, ownerId: number) {
  await db.query(
    `INSERT INTO standings_refresh (owner_kind, owner_id, last_fetched_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (owner_kind, owner_id) DO UPDATE SET last_fetched_at = NOW()`,
    [ownerKind, ownerId],
  );
}

async function replaceStandings(
  table: 'character_standings' | 'corp_standings' | 'alliance_standings',
  ownerCol: 'character_id' | 'corp_id' | 'alliance_id',
  ownerId: number,
  contacts: EsiContact[],
  actorUserId: number | null,
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table} WHERE ${ownerCol} = $1`, [ownerId]);
    if (contacts.length > 0) {
      // Bulk insert using UNNEST for one round-trip.
      const kinds   = contacts.map((c) => c.contact_type);
      const ids     = contacts.map((c) => c.contact_id);
      const values  = contacts.map((c) => c.standing);
      if (table === 'character_standings') {
        await client.query(
          `INSERT INTO ${table} (${ownerCol}, contact_kind, contact_id, standing)
           SELECT $1, k, i, v
           FROM UNNEST($2::text[], $3::int[], $4::real[]) AS t(k, i, v)`,
          [ownerId, kinds, ids, values],
        );
      } else {
        await client.query(
          `INSERT INTO ${table} (${ownerCol}, contact_kind, contact_id, standing, updated_by_user_id)
           SELECT $1, k, i, v, $5
           FROM UNNEST($2::text[], $3::int[], $4::real[]) AS t(k, i, v)`,
          [ownerId, kinds, ids, values, actorUserId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Fire-and-forget standings refresh on login. Pulls personal, corp, and
// alliance contacts in parallel, skipping any list the character didn't grant
// the scope for. Never throws — every
// failure is logged so a transient ESI hiccup doesn't break login.
//
// scope: 'all' (default) refreshes all three buckets — used on login and by the
// system-info "refresh standings" button that powers the map tint. scope: 'org'
// refreshes ONLY corp + alliance and never touches personal contacts — used by
// the access-page sync, since access control only ever reads corp/alliance
// standings (so it must not request the personal endpoint at all).
// Forget a character's personal contacts: called when a login no longer
// allows reading them, so the map stops tinting with a list the pilot took
// back. (Corp and alliance lists are shared by the whole org and are kept.)
export async function forgetPersonalStandings(characterId: number): Promise<void> {
  await db.query(`DELETE FROM character_standings WHERE character_id = $1`, [characterId]);
  await db.query(
    `DELETE FROM standings_refresh WHERE owner_kind = 'character' AND owner_id = $1`, [characterId]);
}

export async function refreshStandingsForUser(params: {
  userId:      number;
  characterId: number;
  corpId:      number | null;
  allianceId:  number | null;
  accessToken: string;
  // The scopes the token holds (null = not recorded yet = all). A contacts list
  // the character didn't grant is skipped rather than asked for and refused.
  scopes?:     readonly string[] | null;
  scope?:      'all' | 'org';
}): Promise<void> {
  const { userId, characterId, corpId, allianceId, accessToken } = params;
  const granted = params.scopes ?? null;
  const scope = params.scope ?? 'all';

  const tasks: Promise<void>[] = [];

  // Personal — for the map tint only (never access control). Skipped for
  // org-scoped syncs.
  if (scope !== 'org' && hasScope(granted, SCOPE.charContacts) && await shouldRefresh('character', characterId)) {
    tasks.push((async () => {
      const r = await fetchAllContacts(
        `https://esi.evetech.net/v2/characters/${characterId}/contacts/`,
        accessToken,
      );
      if (Array.isArray(r)) {
        log.info(`character ${characterId}: fetched ${r.length} personal contacts`);
        await replaceStandings('character_standings', 'character_id', characterId, r, userId);
        await markRefreshed('character', characterId);
      } else {
        log.info(`character ${characterId}: personal contacts fetch returned ${r.status} (${r.error}) — likely missing esi-characters.read_contacts.v1 scope`);
      }
    })().catch((err) => log.error('character standings fetch errored:', err)));
  }

  // Corp — the syncing character's OWN corp, whichever it is, so every pilot gets
  // their corp's friendly/hostile tint, not only the deployment's configured
  // corp. One member's sync serves the whole corp. No in-game role is needed
  // (ESI's spec lists none for this endpoint, unlike corp structures), but ESI
  // only answers for a corp the character is in, so a pilot can only ever fill
  // in their own corp's list. Access control is unaffected: it only reads the
  // rows for config.corpIds (services/accessGrants.ts).
  if (corpId !== null && hasScope(granted, SCOPE.corpContacts)
      && await shouldRefresh('corp', corpId)) {
    tasks.push((async () => {
      const r = await fetchAllContacts(
        `https://esi.evetech.net/v2/corporations/${corpId}/contacts/`,
        accessToken,
      );
      if (Array.isArray(r)) {
        log.info(`corp ${corpId}: fetched ${r.length} corp contacts (via character ${characterId})`);
        await replaceStandings('corp_standings', 'corp_id', corpId, r, userId);
        invalidateOrgContacts('corp', corpId);
        await markRefreshed('corp', corpId);
      } else {
        log.info(`corp ${corpId}: contacts fetch returned ${r.status} (${r.error}) — character ${characterId} may have left the corp or revoked the scope`);
      }
    })().catch((err) => log.error('corp standings fetch errored:', err)));
  }

  // Alliance — the syncing character's own alliance, on the same terms as corp
  // above: any member can read it, and access control only reads the rows for
  // config.allianceIds.
  if (allianceId !== null && hasScope(granted, SCOPE.allianceContacts)
      && await shouldRefresh('alliance', allianceId)) {
    tasks.push((async () => {
      const r = await fetchAllContacts(
        `https://esi.evetech.net/v2/alliances/${allianceId}/contacts/`,
        accessToken,
      );
      if (Array.isArray(r)) {
        log.info(`alliance ${allianceId}: fetched ${r.length} alliance contacts (via character ${characterId})`);
        await replaceStandings('alliance_standings', 'alliance_id', allianceId, r, userId);
        invalidateOrgContacts('alliance', allianceId);
        await markRefreshed('alliance', allianceId);
      } else {
        log.info(`alliance ${allianceId}: contacts fetch returned ${r.status} (${r.error}) — character ${characterId} may have left the alliance or revoked the scope`);
      }
    })().catch((err) => log.error('alliance standings fetch errored:', err)));
  }

  await Promise.allSettled(tasks);
}
