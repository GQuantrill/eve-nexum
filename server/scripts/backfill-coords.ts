/**
 * One-shot backfill of solar_systems.pos_x/pos_y/pos_z from the SDE.
 *
 * The full `npm run setup-db` re-imports the entire SDE; this script only
 * reads mapSolarSystems.jsonl and UPDATEs the three coordinate columns, so an
 * existing deployment can gain region-map coordinates without a full re-seed.
 *
 *   cd server && npx tsx scripts/backfill-coords.ts
 *
 * Uses the SDE zip already in server/data/ (or .sde-cache/sde.zip).
 */
import 'dotenv/config'; // load PG_* from .env before db.ts builds the pool
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as unzipper from 'unzipper';
import { db } from '../src/db.js';

const CACHE    = join(process.cwd(), '.sde-cache');
const SDE_ZIP  = join(CACHE, 'sde.zip');
const DATA_DIR = join(process.cwd(), 'data');

function resolveZip(): string {
  const local = readdirSync(DATA_DIR).find((f) => f.endsWith('.zip'));
  if (local) return join(DATA_DIR, local);
  if (existsSync(SDE_ZIP)) return SDE_ZIP;
  throw new Error('No SDE zip in server/data/ or .sde-cache/. Run `npm run setup-db` first, or drop the SDE zip into server/data/.');
}

async function main() {
  const zipPath = resolveZip();
  console.log(`Backfilling solar_systems coordinates from ${zipPath}`);

  // Be self-sufficient: ensure the columns exist even if the server hasn't
  // run migrate yet on this database.
  await db.query(`
    ALTER TABLE IF EXISTS solar_systems ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION;
    ALTER TABLE IF EXISTS solar_systems ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION;
    ALTER TABLE IF EXISTS solar_systems ADD COLUMN IF NOT EXISTS pos_z DOUBLE PRECISION;
    ALTER TABLE IF EXISTS solar_systems ADD COLUMN IF NOT EXISTS pos2d_x DOUBLE PRECISION;
    ALTER TABLE IF EXISTS solar_systems ADD COLUMN IF NOT EXISTS pos2d_y DOUBLE PRECISION;
  `);

  const zip   = await unzipper.Open.file(zipPath);
  const entry = zip.files.find((f) => f.path === 'mapSolarSystems.jsonl');
  
  if (!entry) throw new Error('mapSolarSystems.jsonl not found in SDE zip');
  const lines = (await entry.buffer()).toString('utf8').split('\n').filter((l) => l.trim());
  

  const rows: [number, number, number, number, number | null, number | null][] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const id = o._key ?? 0;
      const p  = o.position;
      if (!id || !p || typeof p.x !== 'number') continue;
      const p2 = o.position2D;
      rows.push([
        id, p.x, typeof p.y === 'number' ? p.y : 0, typeof p.z === 'number' ? p.z : 0,
        typeof p2?.x === 'number' ? p2.x : null,
        typeof p2?.y === 'number' ? p2.y : null,
      ]);
    } catch { /* skip malformed */ }
  }

  const BATCH = 500;
  const C = 6;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch  = rows.slice(i, i + BATCH);
    const values = batch
      .map((_, j) => `($${j*C+1}::int,$${j*C+2}::float8,$${j*C+3}::float8,$${j*C+4}::float8,$${j*C+5}::float8,$${j*C+6}::float8)`)
      .join(',');
    await db.query(
      `UPDATE solar_systems AS s
          SET pos_x = v.x, pos_y = v.y, pos_z = v.z, pos2d_x = v.x2, pos2d_y = v.y2
         FROM (VALUES ${values}) AS v(id, x, y, z, x2, y2)
        WHERE s.id = v.id`,
      batch.flat(),
    );
    done += batch.length;
    process.stdout.write(`\r  ${done} / ${rows.length}`);
  }

  console.log(`\nBackfilled coordinates for ${done} systems.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
