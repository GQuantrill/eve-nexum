import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('standings');

// Refresh standings at most once every 6 hours per owner. Corp / alliance
// contact lists are typically edited a few times a month, so a 6-hour TTL
// keeps the data fresh enough for ops decisions without re-fetching on
// every login. ESI's own contacts cache is 5 minutes; anything faster
// here just makes the server work harder for no fresher data.
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

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
// alliance contacts in parallel; gracefully no-ops the corp/alliance reads
// when the character lacks the Contact Manager role. Never throws — every
// failure is logged so a transient ESI hiccup doesn't break login.
export async function refreshStandingsForUser(params: {
  userId:      number;
  characterId: number;
  corpId:      number | null;
  allianceId:  number | null;
  accessToken: string;
}): Promise<void> {
  const { userId, characterId, corpId, allianceId, accessToken } = params;

  const tasks: Promise<void>[] = [];

  // Personal — always available with the read_contacts scope.
  if (await shouldRefresh('character', characterId)) {
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

  // Corp — requires the Contact Manager role; 403 is the common case.
  if (corpId !== null && await shouldRefresh('corp', corpId)) {
    tasks.push((async () => {
      const r = await fetchAllContacts(
        `https://esi.evetech.net/v2/corporations/${corpId}/contacts/`,
        accessToken,
      );
      if (Array.isArray(r)) {
        log.info(`corp ${corpId}: fetched ${r.length} corp contacts (via character ${characterId})`);
        await replaceStandings('corp_standings', 'corp_id', corpId, r, userId);
        await markRefreshed('corp', corpId);
      } else {
        log.info(`corp ${corpId}: contacts fetch returned ${r.status} (${r.error}) — character ${characterId} likely lacks Contact Manager role or the read_contacts scope`);
      }
    })().catch((err) => log.error('corp standings fetch errored:', err)));
  }

  // Alliance — requires the character to be in the executor corp with the
  // appropriate role; very rare. 403 is the common case.
  if (allianceId !== null && await shouldRefresh('alliance', allianceId)) {
    tasks.push((async () => {
      const r = await fetchAllContacts(
        `https://esi.evetech.net/v2/alliances/${allianceId}/contacts/`,
        accessToken,
      );
      if (Array.isArray(r)) {
        log.info(`alliance ${allianceId}: fetched ${r.length} alliance contacts (via character ${characterId})`);
        await replaceStandings('alliance_standings', 'alliance_id', allianceId, r, userId);
        await markRefreshed('alliance', allianceId);
      } else {
        log.info(`alliance ${allianceId}: contacts fetch returned ${r.status} (${r.error}) — character ${characterId} likely lacks alliance-executor role or the read_contacts scope`);
      }
    })().catch((err) => log.error('alliance standings fetch errored:', err)));
  }

  await Promise.allSettled(tasks);
}
