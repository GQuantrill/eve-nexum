import { db } from '../db.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('corpStructures');

const REFRESH_TTL_MS = 60 * 60 * 1000; // 1h matches ESI cache TTL
let lastRunByCorpId = new Map<number, number>();

interface EsiCorpStructure {
  structure_id:      number;
  system_id:         number;
  type_id:           number;
  corporation_id:    number;
  name?:             string;
  state?:            string;
  fuel_expires?:     string;
}

// Walk the paginated `/v3/corporations/{corp_id}/structures/` endpoint
// for one user/corp combo. Returns null when ESI rejects the call (403
// = missing scope or role; 401 = bad token).
async function fetchAllPages(corpId: number, token: string): Promise<EsiCorpStructure[] | null> {
  const all: EsiCorpStructure[] = [];
  let page = 1;
  while (true) {
    const r = await fetch(`https://esi.evetech.net/v3/corporations/${corpId}/structures/?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 403) return null;
    if (r.status === 401) return null;
    if (!r.ok) {
      log.warn(`ESI corp ${corpId} structures returned ${r.status}`);
      return null;
    }
    const batch = await r.json() as EsiCorpStructure[];
    all.push(...batch);
    const pages = parseInt(r.headers.get('x-pages') ?? '1', 10);
    if (page >= pages) break;
    page += 1;
    if (page > 20) break; // safety: 2000 structures should cover any sane corp
  }
  return all;
}

// Find a logged-in member of the corp whose token we can use. Just picks
// the most-recently-active user; if they don't have the role the ESI
// call returns 403 and we move on. Could be smarter (cache "this user
// has the role"), but the cost of a 403 is one HTTP request per refresh.
async function pickActorForCorp(corpId: number): Promise<{ userId: number; token: string } | null> {
  const { rows } = await db.query<{ id: number; access_token: string }>(
    `SELECT id, access_token FROM users
     WHERE corp_id = $1 AND blocked = FALSE AND access_token IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`,
    [corpId],
  );
  if (!rows.length) return null;
  try { return { userId: rows[0].id, token: decryptToken(rows[0].access_token) }; }
  catch (err) { log.warn(`failed to decrypt token for user ${rows[0].id}:`, err); return null; }
}

async function upsertStructures(corpId: number, structs: EsiCorpStructure[]): Promise<void> {
  if (structs.length === 0) return;
  const ids       = structs.map((s) => s.structure_id);
  const systems   = structs.map((s) => s.system_id);
  const owners    = structs.map((s) => s.corporation_id);
  const names     = structs.map((s) => s.name ?? '');
  const types     = structs.map((s) => s.type_id);

  await db.query(
    `INSERT INTO known_structures
       (structure_id, system_id, owner_corp_id, name, type_id, source, restricted_to_corp_id, last_seen_at)
     SELECT t.id, t.sys, t.owner, t.name, t.type, 'corp-esi', $6, NOW()
     FROM UNNEST($1::bigint[], $2::int[], $3::int[], $4::text[], $5::int[])
       AS t(id, sys, owner, name, type)
     ON CONFLICT (structure_id) DO UPDATE SET
       system_id     = EXCLUDED.system_id,
       owner_corp_id = EXCLUDED.owner_corp_id,
       name          = EXCLUDED.name,
       type_id       = EXCLUDED.type_id,
       source        = EXCLUDED.source,
       restricted_to_corp_id = EXCLUDED.restricted_to_corp_id,
       last_seen_at  = NOW()`,
    [ids, systems, owners, names, types, corpId],
  );
}

// Refresh structures for one corp. Cheap to call repeatedly; honours the
// 1-hour TTL so back-to-back calls are no-ops. Public so the admin
// dashboard can force-refresh if needed.
export async function refreshCorpStructures(corpId: number, opts: { force?: boolean } = {}): Promise<{
  ok: boolean; count: number; reason?: string;
}> {
  const last = lastRunByCorpId.get(corpId) ?? 0;
  if (!opts.force && Date.now() - last < REFRESH_TTL_MS) {
    return { ok: true, count: 0, reason: 'cached' };
  }
  const actor = await pickActorForCorp(corpId);
  if (!actor) return { ok: false, count: 0, reason: 'no-actor' };

  const structs = await fetchAllPages(corpId, actor.token);
  if (structs === null) return { ok: false, count: 0, reason: 'esi-denied' };

  await upsertStructures(corpId, structs);
  lastRunByCorpId.set(corpId, Date.now());
  log.info(`corp ${corpId}: refreshed ${structs.length} structures`);
  return { ok: true, count: structs.length };
}

// Background scheduler. Picks every corp that has at least one user and
// tries a refresh. Per-corp TTL prevents thrashing.
export async function refreshAllCorps(): Promise<void> {
  const { rows } = await db.query<{ corp_id: number }>(
    `SELECT DISTINCT corp_id FROM users WHERE corp_id IS NOT NULL`,
  );
  for (const { corp_id } of rows) {
    try { await refreshCorpStructures(corp_id); }
    catch (err) { log.error(`refresh failed for corp ${corp_id}:`, err); }
  }
}

const POLL_MS = 60 * 60 * 1000; // hourly

export function initCorpStructuresPoller(): void {
  // Kick once on boot, then hourly.
  refreshAllCorps().catch((err) => log.error('boot refresh failed:', err));
  setInterval(() => {
    refreshAllCorps().catch((err) => log.error('scheduled refresh failed:', err));
  }, POLL_MS);
}
