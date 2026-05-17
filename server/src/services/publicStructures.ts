import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('publicStructures');

// Expected format for an entry in the upstream feed. We accept a small
// set of synonyms because different crowdsourced dumps use different
// field names. Required: a numeric structure ID and a system ID. The
// rest are best-effort.
interface PublicStructureInput {
  structure_id?:  number | string;
  structureID?:   number | string;
  id?:            number | string;
  system_id?:     number | string;
  systemID?:      number | string;
  solar_system_id?: number | string;
  owner_id?:      number | string;
  corp_id?:       number | string;
  name?:          string;
  type_id?:       number | string;
  typeID?:        number | string;
}

interface Normalised {
  structure_id: number;
  system_id:    number;
  owner_corp:   number | null;
  name:         string;
  type_id:      number | null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalise(raw: PublicStructureInput): Normalised | null {
  const structure_id = num(raw.structure_id ?? raw.structureID ?? raw.id);
  const system_id    = num(raw.system_id ?? raw.systemID ?? raw.solar_system_id);
  if (!structure_id || !system_id) return null;
  return {
    structure_id,
    system_id,
    owner_corp: num(raw.owner_id ?? raw.corp_id),
    name:       typeof raw.name === 'string' ? raw.name : '',
    type_id:    num(raw.type_id ?? raw.typeID),
  };
}

// Accept JSON in one of two shapes:
//   1) Array<{structure_id, system_id, ...}>
//   2) Record<structure_id, { system_id, ... }>
// Anything else is rejected with a descriptive error.
function extractRows(payload: unknown): PublicStructureInput[] {
  if (Array.isArray(payload)) return payload as PublicStructureInput[];
  if (payload && typeof payload === 'object') {
    return Object.entries(payload as Record<string, unknown>).map(([id, v]) => {
      const obj = (v && typeof v === 'object') ? v as PublicStructureInput : {};
      return { structure_id: id, ...obj };
    });
  }
  throw new Error('Public-structures payload must be an array or an object keyed by structure ID');
}

// Bulk-upsert into `known_structures`. Public-source rows are flagged
// with `restricted_to_corp_id = NULL` so every authenticated user can
// see them.
async function bulkUpsert(rows: Normalised[]): Promise<number> {
  if (rows.length === 0) return 0;
  const ids     = rows.map((r) => r.structure_id);
  const systems = rows.map((r) => r.system_id);
  const owners  = rows.map((r) => r.owner_corp);
  const names   = rows.map((r) => r.name);
  const types   = rows.map((r) => r.type_id);
  await db.query(
    `INSERT INTO known_structures
       (structure_id, system_id, owner_corp_id, name, type_id, source, restricted_to_corp_id, last_seen_at)
     SELECT t.id, t.sys, t.owner, t.name, t.type, 'public-dataset', NULL, NOW()
     FROM UNNEST($1::bigint[], $2::int[], $3::int[], $4::text[], $5::int[])
       AS t(id, sys, owner, name, type)
     ON CONFLICT (structure_id) DO UPDATE SET
       -- Don't clobber a corp-esi row with a less-authoritative public
       -- one. ESI data always wins.
       system_id     = CASE WHEN known_structures.source = 'corp-esi' THEN known_structures.system_id     ELSE EXCLUDED.system_id     END,
       owner_corp_id = CASE WHEN known_structures.source = 'corp-esi' THEN known_structures.owner_corp_id ELSE EXCLUDED.owner_corp_id END,
       name          = CASE WHEN known_structures.source = 'corp-esi' THEN known_structures.name          ELSE EXCLUDED.name          END,
       type_id       = CASE WHEN known_structures.source = 'corp-esi' THEN known_structures.type_id       ELSE EXCLUDED.type_id       END,
       source        = CASE WHEN known_structures.source = 'corp-esi' THEN known_structures.source        ELSE EXCLUDED.source        END,
       last_seen_at  = NOW()`,
    [ids, systems, owners, names, types],
  );
  return rows.length;
}

export interface ImportResult {
  ok: boolean;
  fetched?: number;
  imported?: number;
  reason?: string;
}

// Import from a remote URL (configured via PUBLIC_STRUCTURES_URL). The
// expected format is documented in the README; in short, JSON shaped as
// either an array or a structure-id-keyed object with `system_id`,
// `owner_id`, `name`, and `type_id` per entry.
export async function importFromUrl(url: string): Promise<ImportResult> {
  let payload: unknown;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { ok: false, reason: `upstream ${r.status}` };
    payload = await r.json();
  } catch (err) {
    log.error('fetch failed:', err);
    return { ok: false, reason: 'fetch-failed' };
  }
  let raws: PublicStructureInput[];
  try { raws = extractRows(payload); }
  catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const rows = raws.map(normalise).filter((r): r is Normalised => r !== null);
  const imported = await bulkUpsert(rows);
  log.info(`imported ${imported} public structures from ${url}`);
  return { ok: true, fetched: raws.length, imported };
}

const DAILY_MS = 24 * 60 * 60 * 1000;

export function initPublicStructuresPoller(): void {
  const url = process.env.PUBLIC_STRUCTURES_URL;
  if (!url) {
    log.info('PUBLIC_STRUCTURES_URL unset — skipping public-structure import scheduler');
    return;
  }
  // Kick once on boot, then daily.
  importFromUrl(url).catch((err) => log.error('boot import failed:', err));
  setInterval(() => {
    importFromUrl(url).catch((err) => log.error('scheduled import failed:', err));
  }, DAILY_MS);
}
