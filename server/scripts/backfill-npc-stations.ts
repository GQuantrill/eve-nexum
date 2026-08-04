/**
 * One-shot backfill of npc_stations from the SDE.
 *
 * The full `npm run setup-db` re-imports the entire SDE; this reads only
 * npcStations.jsonl and populates npc_stations, so an existing deployment can
 * gain NPC-station jump-planner endpoints without a full re-seed.
 *
 *   cd server && npx tsx scripts/backfill-npc-stations.ts
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
  console.log(`Backfilling npc_stations from ${zipPath}`);

  // Self-sufficient: ensure the table exists even if the server hasn't migrated.
  await db.query(`
    CREATE TABLE IF NOT EXISTS npc_stations (
      station_id BIGINT PRIMARY KEY, solar_system_id INTEGER, type_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_npc_stations_system ON npc_stations (solar_system_id);
  `);

  const zip   = await unzipper.Open.file(zipPath);
  const entry = zip.files.find((f) => f.path === 'npcStations.jsonl');
  if (!entry) throw new Error('npcStations.jsonl not found in SDE zip');
  const lines = (await entry.buffer()).toString('utf8').split('\n').filter((l) => l.trim());

  const rows: [number, number, number][] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key || !o.solarSystemID || !o.typeID) continue;
      rows.push([o._key, o.solarSystemID, o.typeID]);
    } catch { /* skip malformed */ }
  }

  const BATCH = 500, C = 3;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch  = rows.slice(i, i + BATCH);
    const values = batch.map((_, j) => `($${j*C+1}::bigint,$${j*C+2}::int,$${j*C+3}::int)`).join(',');
    await db.query(
      `INSERT INTO npc_stations (station_id, solar_system_id, type_id)
       VALUES ${values}
       ON CONFLICT (station_id) DO UPDATE
         SET solar_system_id = EXCLUDED.solar_system_id, type_id = EXCLUDED.type_id`,
      batch.flat(),
    );
    done += batch.length;
    process.stdout.write(`\r  ${done} / ${rows.length}`);
  }

  console.log(`\nBackfilled ${done} NPC stations.`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
