// Pulls a corp's Upwell structures from ESI into the `structures` table so they
// can serve as jump-planner endpoints. Only a member with the Station Manager or
// Director corp role can list corp structures, and the read_structures scope must
// have been granted (older logins predate it — those get 'needs_reauth'). The
// full corp set is replaced on each sync, so removed structures drop out.
import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { getValidToken } from '../utils/eveToken.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('structureSync');
const ESI = 'https://esi.evetech.net/latest';
const STRUCTURE_ROLES = ['Station_Manager', 'Director'];
// Auto-sync is TTL-gated so a login doesn't re-pull every time (mirrors the
// standings refresh window). The manual "Sync from ESI" button passes force.
const SYNC_TTL_MS = 6 * 60 * 60 * 1000;

// Reuse the generic standings_refresh timestamp table (owner_kind/owner_id KV)
// so we don't need a dedicated one. Only marked on a successful sync, so a
// no_role attempt never suppresses a later role-holder's populate.
async function structuresFresh(corpId: number): Promise<boolean> {
  const { rows } = await db.query<{ last_fetched_at: string }>(
    `SELECT last_fetched_at FROM standings_refresh WHERE owner_kind = 'corp_structures' AND owner_id = $1`, [corpId],
  );
  return rows.length > 0 && Date.now() - new Date(rows[0].last_fetched_at).getTime() < SYNC_TTL_MS;
}
async function markStructuresSynced(corpId: number): Promise<void> {
  await db.query(
    `INSERT INTO standings_refresh (owner_kind, owner_id, last_fetched_at) VALUES ('corp_structures', $1, NOW())
     ON CONFLICT (owner_kind, owner_id) DO UPDATE SET last_fetched_at = NOW()`, [corpId],
  );
}

export type StructureSyncResult =
  | { status: 'ok'; count: number }
  | { status: 'skipped' }       // synced recently (TTL) — auto-sync only
  | { status: 'no_corp' }       // user has no corp on record
  | { status: 'no_role' }       // not a Station Manager / Director
  | { status: 'needs_reauth' }  // read_structures scope not granted (or token dead)
  | { status: 'error' };

interface CorpStructure { structure_id: number; system_id: number; type_id: number }

export async function syncCorpStructures(userId: number, opts: { force?: boolean } = {}): Promise<StructureSyncResult> {
  const { rows } = await db.query<{ character_id: number | null; corp_id: number | null }>(
    `SELECT character_id, corp_id FROM users WHERE id = $1`, [userId],
  );
  const u = rows[0];
  if (!u?.corp_id || !u.character_id) return { status: 'no_corp' };
  const corpId = u.corp_id;

  // Cheap DB gate before any ESI call: skip if a recent sync covers this corp.
  if (!opts.force && await structuresFresh(corpId)) return { status: 'skipped' };

  let token: string;
  try { token = await getValidToken(userId); }
  catch { return { status: 'needs_reauth' }; }
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // Gate on the EVE corp role first. read_corporation_roles is in the base scope
  // set (granted since before read_structures existed), so this check works even
  // for a user who hasn't re-consented yet — letting us tell 'no_role' apart from
  // 'needs_reauth' instead of blindly 403-ing the corp/structures endpoint.
  const rolesRes = await esiFetch(`${ESI}/characters/${u.character_id}/roles/`, auth);
  if (rolesRes.status === 401 || rolesRes.status === 403) return { status: 'needs_reauth' };
  if (!rolesRes.ok) return { status: 'error' };
  const rolesJson = await rolesRes.json() as { roles?: string[] };
  if (!(rolesJson.roles ?? []).some((r) => STRUCTURE_ROLES.includes(r))) return { status: 'no_role' };

  // Page through the corp's structures. A 403 here (with the role present) means
  // the read_structures scope isn't on the token yet — prompt a re-login.
  const all: CorpStructure[] = [];
  let page = 1, pages = 1;
  do {
    const res = await esiFetch(`${ESI}/corporations/${corpId}/structures/?page=${page}`, auth);
    if (res.status === 401 || res.status === 403) return { status: 'needs_reauth' };
    if (!res.ok) { log.warn(`corp ${corpId} structures page ${page} -> ${res.status}`); return { status: 'error' }; }
    pages = parseInt(res.headers.get('x-pages') ?? '1', 10) || 1;
    all.push(...(await res.json() as CorpStructure[]));
    page++;
  } while (page <= pages);

  // Resolve each structure's name (universe/structures — same token). Failures
  // leave the name blank rather than aborting the whole sync.
  const named = await Promise.all(all.map(async (s) => {
    try {
      const nres = await esiFetch(`${ESI}/universe/structures/${s.structure_id}/`, auth);
      if (nres.ok) return { ...s, name: ((await nres.json()) as { name?: string }).name ?? '' };
    } catch { /* fall through */ }
    return { ...s, name: '' };
  }));

  // type_id -> type name from the SDE (item_types).
  const typeIds = [...new Set(named.map((s) => s.type_id))];
  const typeNames = new Map<number, string>();
  if (typeIds.length) {
    const { rows: tr } = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM item_types WHERE id = ANY($1::int[])`, [typeIds],
    );
    tr.forEach((t) => typeNames.set(t.id, t.name));
  }

  // Replace this corp's structure set atomically (mirrors the standings sync).
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM structures WHERE corporation_id = $1`, [corpId]);
    if (named.length) {
      await client.query(
        `INSERT INTO structures (structure_id, corporation_id, name, solar_system_id, type_id, type_name, updated_at)
         SELECT sid, $1, nm, sys, tid, tnm, NOW()
         FROM UNNEST($2::bigint[], $3::text[], $4::int[], $5::int[], $6::text[]) AS t(sid, nm, sys, tid, tnm)`,
        [
          corpId,
          named.map((s) => s.structure_id),
          named.map((s) => s.name),
          named.map((s) => s.system_id),
          named.map((s) => s.type_id),
          named.map((s) => typeNames.get(s.type_id) ?? ''),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.error('structure upsert failed', err);
    return { status: 'error' };
  } finally {
    client.release();
  }

  await markStructuresSynced(corpId);
  log.info(`synced ${named.length} structures for corp ${corpId}`);
  return { status: 'ok', count: named.length };
}
