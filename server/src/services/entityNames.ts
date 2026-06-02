import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('entityNames');

// ESI POST /universe/names/ accepts up to 1000 IDs per call.
const ESI_BATCH_SIZE = 1000;
const ESI_TIMEOUT_MS = 8_000;

export interface EntityName {
  name:     string;
  category: string;
}

interface EsiNameRow {
  id:       number;
  name:     string;
  category: string;
}

/**
 * Resolve EVE entity IDs (characters, corporations, alliances, factions,
 * solar systems, etc.) to their human-readable names.
 *
 * Strategy:
 *  1. SELECT the cache table for everything we already know.
 *  2. POST the misses to ESI /universe/names/ (1000 at a time).
 *  3. INSERT the responses back into the cache for next time.
 *  4. Return a single Map keyed by id.
 *
 * Unknown IDs (deleted characters, NPC corps with no public record) simply
 * don't appear in the returned map — callers should fall back gracefully.
 *
 * Cheap: the public ESI endpoint requires no auth, and the cache amortises
 * the cost across every render of every feature that needs names.
 */
export async function resolveEntityNames(rawIds: Array<number | null | undefined>): Promise<Map<number, EntityName>> {
  const out  = new Map<number, EntityName>();
  const want = [...new Set(
    rawIds.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0),
  )];
  if (want.length === 0) return out;

  const cached = await db.query<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM entity_names WHERE id = ANY($1::bigint[])`,
    [want],
  );
  for (const row of cached.rows) {
    out.set(Number(row.id), { name: row.name, category: row.category });
  }

  const missing = want.filter((id) => !out.has(id));
  if (missing.length === 0) return out;

  // Batch the ESI call. ESI returns 400 for any invalid id in the batch, so
  // split into chunks small enough to be safe and skip a chunk on error
  // rather than failing the whole resolve.
  const resolvedRows: EsiNameRow[] = [];
  for (let i = 0; i < missing.length; i += ESI_BATCH_SIZE) {
    const chunk = missing.slice(i, i + ESI_BATCH_SIZE);
    try {
      const res = await esiFetch('https://esi.evetech.net/latest/universe/names/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(chunk),
        signal:  AbortSignal.timeout(ESI_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn(`ESI /universe/names/ returned ${res.status} for batch of ${chunk.length}`);
        continue;
      }
      const body = (await res.json()) as EsiNameRow[];
      if (!Array.isArray(body)) continue;
      resolvedRows.push(...body);
    } catch (err) {
      log.warn('ESI /universe/names/ batch failed:', err);
    }
  }

  if (resolvedRows.length === 0) return out;

  // Bulk INSERT into the cache. ON CONFLICT keeps the table self-healing —
  // a concurrent resolver populating the same id is a no-op for us.
  const values: unknown[]     = [];
  const placeholders: string[] = [];
  resolvedRows.forEach((row, i) => {
    const base = i * 3;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    values.push(row.id, row.name, row.category);
  });
  await db.query(
    `INSERT INTO entity_names (id, name, category)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (id) DO UPDATE SET
       name       = EXCLUDED.name,
       category   = EXCLUDED.category,
       fetched_at = NOW()`,
    values,
  );

  for (const row of resolvedRows) {
    out.set(row.id, { name: row.name, category: row.category });
  }
  return out;
}
