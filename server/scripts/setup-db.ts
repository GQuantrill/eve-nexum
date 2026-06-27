/**
 * Creates the database schema and imports EVE SDE data.
 *
 * Run:  yarn setup-db
 *
 * Prerequisites:
 *   - server/data/ seed files present (wormhole_systems.csv, wormholes.json, wormhole_effects.json)
 *   - CCP SDE zip in server/data/ (or let this script download it to .sde-cache/)
 *   - DATABASE env vars set (see .env.example)
 *
 * Tables imported:
 *   map_regions, map_constellations, solar_systems, map_stargates,
 *   item_categories, item_groups, item_types,
 *   dogma_attributes, item_dogma_attributes,
 *   factions, meta_groups
 */

import 'dotenv/config';
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import * as unzipper from 'unzipper';
import { db } from '../src/db.js';

const SDE_URL  = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';
const CACHE    = join(process.cwd(), '.sde-cache');
const SDE_ZIP  = join(CACHE, 'sde.zip');
const DATA_DIR = join(process.cwd(), 'data');

const WH_CLASS: Record<number, string> = {
  1:'C1', 2:'C2', 3:'C3', 4:'C4', 5:'C5', 6:'C6',
  12:'Thera', 13:'C13', 14:'Drifter',
  15:'Drifter', 16:'Drifter', 17:'Drifter', 18:'Drifter',
};

const EFFECT_MAP: Record<string, string> = {
  'Red Giant':            'red_giant',
  'Black Hole':           'black_hole',
  'Cataclysmic Variable': 'cataclysmic_variable',
  'Pulsar':               'pulsar',
  'Wolf-Rayet':           'wolf_rayet',
  'Wolf-Rayet Star':      'wolf_rayet',
  'Magnetar':             'magnetar',
};

type WhData = { class: string; effect: string | null; statics: string[] };
type Zip    = Awaited<ReturnType<typeof unzipper.Open.file>>;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== nexum DB Setup ===\n');

  checkSeedFiles();
  await mkdir(CACHE, { recursive: true });
  await createTables();

  // The import downloads ~80 MB and takes minutes, so skip it when the data is
  // already present AND matches the latest SDE build. This makes the script
  // safe to run on every `docker compose up` and on the daily auto-update
  // check — most days it's just one cheap HEAD request and an early return.
  const force        = process.env.FORCE_SDE_IMPORT === '1';
  const { rows }     = await db.query('SELECT count(*)::int AS n FROM solar_systems');
  const haveData     = rows[0].n > 0;
  const remoteVer    = await fetchSdeVersion();
  const storedVer    = await getStoredSdeVersion();

  if (!force && haveData) {
    if (!remoteVer) {
      // Couldn't reach CCP to confirm the latest build — never blow away good
      // data on a transient network blip. Leave what's there and bail.
      console.log('Could not check the latest SDE build; data already present, skipping.');
      await db.end();
      return;
    }
    if (remoteVer === storedVer) {
      console.log(`SDE up to date (build ${remoteVer}). Skipping.`);
      console.log('Set FORCE_SDE_IMPORT=1 to re-import anyway.');
      await db.end();
      return;
    }
    console.log(`New SDE build detected: have ${storedVer ?? 'unknown'}, latest ${remoteVer}. Re-importing.\n`);
  }

  // On an existing DB we always pull a fresh copy: a stale zip baked into the
  // image or left in .sde-cache would silently re-import the old build.
  const resolved = await resolveZip(haveData);
  // Record the build we actually import — which may be an older zip baked into
  // the image, not the latest remote build. Recording remoteVer here would make
  // the daily check think we're current and never pull the newer data.
  const importedVer = resolved.version ?? remoteVer;
  console.log(`\nUsing SDE: ${resolved.path}\n`);
  const zip = await unzipper.Open.file(resolved.path);

  const whMap               = loadWhSystems();
  const constellationRegion = await importRegions(zip);
  await importConstellations(zip, constellationRegion);
  await importSolarSystems(zip, whMap, constellationRegion);
  await importStargates(zip);
  await importCategories(zip);
  await importGroups(zip);
  await importTypes(zip);
  // After importTypes: importStars resolves each star's typeID to its item_types
  // name for sun_type, and importCelestialCounts needs the gates from above.
  await importStars(zip);
  await importCelestialCounts(zip);
  await importShattered(zip);
  await importDogmaAttributes(zip);
  await importItemDogma(zip);
  await importFactions(zip);
  await importMetaGroups(zip);
  await seedRegionNpcTypes();

  if (importedVer) await setStoredSdeVersion(importedVer);

  // Reclaim disk: drop the downloaded zip now that it's imported. The re-import
  // path always re-downloads a fresh copy, so the cached zip is never reused
  // between runs — keeping it just wastes ~80 MB. Only the runtime download is
  // removed; the versioned zip baked into the image under data/ is left alone.
  if (resolved.path === SDE_ZIP) {
    await rm(SDE_ZIP, { force: true }).catch((err) => {
      console.warn(`Could not remove cached SDE zip: ${(err as Error).message}`);
    });
  }

  await db.end();
  console.log(`\nSetup complete${importedVer ? ` (SDE build ${importedVer})` : ''}.`);
}

// ─── Zip resolution ──────────────────────────────────────────────────────────

// Pull the CCP build number out of an SDE filename or URL, e.g.
// `eve-online-static-data-3365090-jsonl.zip` → "3365090".
function parseBuild(s: string): string | null {
  return s.match(/static-data-(\d+)-jsonl/)?.[1] ?? null;
}

async function resolveZip(preferFresh = false): Promise<{ path: string; version: string | null }> {
  // preferFresh (used when re-importing an existing DB): always download the
  // latest, bypassing any baked-in or cached zip that may be stale.
  if (preferFresh) {
    const version = await downloadSde();
    return { path: SDE_ZIP, version };
  }
  // A versioned zip baked into the image (server/data/) is used as-is on a
  // fresh install for speed — its filename tells us which build it is. We
  // deliberately don't reuse an unversioned .sde-cache/sde.zip here: we can't
  // know its build, so we download instead (which gives us the build number).
  const local = readdirSync(DATA_DIR).find(f => f.endsWith('.zip'));
  if (local) return { path: join(DATA_DIR, local), version: parseBuild(local) };
  const version = await downloadSde();
  return { path: SDE_ZIP, version };
}

// ─── SDE version (build number) ────────────────────────────────────────────────

/**
 * Determine the latest SDE build without downloading it. CCP's "latest" URL
 * 302-redirects to a versioned filename embedding the build number, e.g.
 * `…/eve-online-static-data-3365090-jsonl.zip` → "3365090". One HEAD request,
 * no body. Falls back to the resolved file's ETag if the URL shape changes.
 * Returns null on any network error so callers can fail safe.
 */
async function fetchSdeVersion(): Promise<string | null> {
  try {
    const res = await fetch(SDE_URL, { method: 'HEAD', redirect: 'manual' });
    const build = parseBuild(res.headers.get('location') ?? '');
    if (build) return build;
    const head = await fetch(SDE_URL, { method: 'HEAD' });
    return head.headers.get('etag') ?? head.headers.get('last-modified');
  } catch (err) {
    console.warn(`Could not determine latest SDE build: ${(err as Error).message}`);
    return null;
  }
}

async function getStoredSdeVersion(): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM sde_meta WHERE key = 'sde_version'`,
  );
  return rows[0]?.value ?? null;
}

async function setStoredSdeVersion(version: string): Promise<void> {
  await db.query(
    `INSERT INTO sde_meta (key, value, updated_at) VALUES ('sde_version', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [version],
  );
}

// ─── Setup helpers ───────────────────────────────────────────────────────────

function checkSeedFiles() {
  const required = ['wormhole_systems.csv', 'wormholes.json', 'wormhole_effects.json'];
  const missing  = required.filter(f => !existsSync(join(DATA_DIR, f)));
  if (missing.length) {
    console.error(`Missing seed files in server/data/:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
}

async function createTables() {
  process.stdout.write('Creating tables... ');

  // Step 1: tables + ALTER (must precede index creation on new columns)
  await db.query(`
    CREATE TABLE IF NOT EXISTS map_regions (
      id       INTEGER PRIMARY KEY,
      name     TEXT    NOT NULL,
      npc_type TEXT
    );

    CREATE TABLE IF NOT EXISTS map_constellations (
      id        INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      region_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS solar_systems (
      id       INTEGER      PRIMARY KEY,
      name     TEXT         NOT NULL,
      security NUMERIC(6,4) NOT NULL,
      class    TEXT,
      effect   TEXT,
      statics  TEXT[]       NOT NULL DEFAULT '{}'
    );
    ALTER TABLE map_regions ADD COLUMN IF NOT EXISTS npc_type TEXT;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS constellation_id INTEGER;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS region_id INTEGER;
    -- Universe coordinates (metres) from the mapSolarSystems position object,
    -- plus CCP's 2D star-map projection (position2D) used for region map
    -- layouts — connected systems sit adjacent like the in-game map / Dotlan.
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos_z DOUBLE PRECISION;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos2d_x DOUBLE PRECISION;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos2d_y DOUBLE PRECISION;
    -- True for systems whose star is "Sun A0 (Blue Small)" (typeID 3801) — the
    -- in-game A0 classification (distinct from statistics.spectralClass, which
    -- doesn't agree with it). Drives the ★ icon on system nodes. Set by
    -- importStars from mapStars.jsonl, so it refreshes on every SDE re-seed.
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS is_a0 BOOLEAN NOT NULL DEFAULT FALSE;
    -- True for shattered systems — every planet is "Planet (Shattered)" (typeID
    -- 30889): the C13 frigate holes, the Drifter wormholes, and the shattered
    -- C1-C6 variants. Drives the fragments icon on system nodes. Set by
    -- importShattered from mapPlanets.jsonl, so it refreshes on every SDE re-seed.
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS shattered BOOLEAN NOT NULL DEFAULT FALSE;
    -- Static celestial metadata for the system-info panel (sun type + planet /
    -- moon / belt / stargate counts), filled by importSolarSystems, importStars
    -- and importCelestialCounts. Lets the panel render without a live ESI call.
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS sun_type       TEXT;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS planet_count   INTEGER;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS moon_count     INTEGER;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS belt_count     INTEGER;
    ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS stargate_count INTEGER;

    CREATE TABLE IF NOT EXISTS map_stargates (
      id                    INTEGER PRIMARY KEY,
      system_id             INTEGER NOT NULL,
      destination_gate_id   INTEGER NOT NULL,
      destination_system_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_categories (
      id        INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      published BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS item_groups (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      category_id INTEGER NOT NULL,
      published   BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS item_types (
      id          INTEGER  PRIMARY KEY,
      name        TEXT     NOT NULL,
      group_id    INTEGER  NOT NULL,
      mass        NUMERIC,
      volume      NUMERIC,
      description TEXT,
      published   BOOLEAN  NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS dogma_attributes (
      id           INTEGER PRIMARY KEY,
      name         TEXT    NOT NULL,
      description  TEXT,
      high_is_good BOOLEAN NOT NULL DEFAULT true,
      stackable    BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS item_dogma_attributes (
      type_id      INTEGER NOT NULL,
      attribute_id INTEGER NOT NULL,
      value        NUMERIC NOT NULL,
      PRIMARY KEY (type_id, attribute_id)
    );

    CREATE TABLE IF NOT EXISTS factions (
      id   INTEGER PRIMARY KEY,
      name TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta_groups (
      id   INTEGER PRIMARY KEY,
      name TEXT    NOT NULL
    );

    -- Small key/value table. 'sde_version' records the CCP build number of the
    -- last successful import, so we can detect a new SDE drop without
    -- re-importing (see fetchSdeVersion / the daily auto-update check).
    CREATE TABLE IF NOT EXISTS sde_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // App tables: users, maps, map_systems, map_connections
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL      PRIMARY KEY,
      character_id     BIGINT      UNIQUE NOT NULL,
      character_name   TEXT        NOT NULL,
      access_token     TEXT,
      refresh_token    TEXT,
      token_expires_at TIMESTAMPTZ,
      compact_mode     BOOLEAN     NOT NULL DEFAULT FALSE,
      snap_to_grid     BOOLEAN     NOT NULL DEFAULT FALSE,
      show_minimap     BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS compact_mode  BOOLEAN  NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS snap_to_grid  BOOLEAN  NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_minimap  BOOLEAN  NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS panel_order   TEXT[]   NOT NULL DEFAULT '{notes,signatures}';

    CREATE TABLE IF NOT EXISTS maps (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT        NOT NULL DEFAULT 'New Map',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS map_systems (
      id            UUID        PRIMARY KEY,
      map_id        UUID        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      eve_system_id INTEGER,
      name          TEXT        NOT NULL,
      system_class  TEXT        NOT NULL,
      effect        TEXT        NOT NULL DEFAULT 'none',
      statics       TEXT[]      NOT NULL DEFAULT '{}',
      region_name   TEXT,
      npc_type      TEXT,
      position_x    REAL        NOT NULL DEFAULT 0,
      position_y    REAL        NOT NULL DEFAULT 0,
      status        TEXT        NOT NULL DEFAULT 'unknown',
      is_home       BOOLEAN     NOT NULL DEFAULT FALSE,
      locked        BOOLEAN     NOT NULL DEFAULT FALSE,
      notes         TEXT        NOT NULL DEFAULT '',
      labels        TEXT[]      NOT NULL DEFAULT '{}',
      custom_labels TEXT[]      NOT NULL DEFAULT '{}',
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS map_connections (
      id              UUID        PRIMARY KEY,
      map_id          UUID        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      source_id       UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      target_id       UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      source_handle   TEXT,
      target_handle   TEXT,
      connection_type TEXT        NOT NULL DEFAULT 'standard',
      mass_status     TEXT,
      time_status     TEXT,
      size            TEXT        NOT NULL DEFAULT 'large',
      wh_type         TEXT,
      mass_used       BIGINT      NOT NULL DEFAULT 0,
      eol_at          TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS map_signatures (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      system_id   UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      sig_id      TEXT        NOT NULL DEFAULT '',
      sig_type    TEXT        NOT NULL DEFAULT 'unknown',
      name        TEXT        NOT NULL DEFAULT '',
      notes       TEXT        NOT NULL DEFAULT '',
      wh_type     TEXT        NOT NULL DEFAULT '',
      wh_leads_to TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS map_structures (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      system_id       UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      name            TEXT        NOT NULL DEFAULT '',
      structure_type  TEXT        NOT NULL DEFAULT 'unknown',
      owner_corp      TEXT        NOT NULL DEFAULT '',
      eve_id          BIGINT,
      notes           TEXT        NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS map_anomalies (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      system_id   UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      anom_id     TEXT        NOT NULL DEFAULT '',
      anom_type   TEXT        NOT NULL DEFAULT 'unknown',
      name        TEXT        NOT NULL DEFAULT '',
      notes       TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    ALTER TABLE map_structures ADD COLUMN IF NOT EXISTS eve_id BIGINT;

    ALTER TABLE users ALTER COLUMN panel_order SET DEFAULT '{notes,signatures,anomalies,structures,npcStations}';
  `);

  // Step 1.5: fix missing columns. `CREATE TABLE IF NOT EXISTS` above is a no-op
  // when a table already exists from an older deploy, so it won't add columns
  // introduced later by src/migrate.ts. Add the ones the importer would
  // otherwise reference before the server migration runs. Idempotent; migrate.ts
  // re-adds these where the app schema is fully owned.
  await db.query(`
    ALTER TABLE map_signatures ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE map_structures ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE map_anomalies  ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Step 2: static/SDE indexes. App-table indexes live in src/migrate.ts,
  // where the full app schema columns are guaranteed to exist.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_solar_systems_name          ON solar_systems (name text_pattern_ops);
    CREATE INDEX IF NOT EXISTS idx_solar_systems_constellation ON solar_systems (constellation_id);
    CREATE INDEX IF NOT EXISTS idx_solar_systems_region        ON solar_systems (region_id);
    CREATE INDEX IF NOT EXISTS idx_stargates_system            ON map_stargates (system_id);
    CREATE INDEX IF NOT EXISTS idx_item_groups_category        ON item_groups (category_id);
    CREATE INDEX IF NOT EXISTS idx_item_types_group            ON item_types (group_id);
    CREATE INDEX IF NOT EXISTS idx_item_types_name             ON item_types (name text_pattern_ops);
  `);

  console.log('done');
}

// ─── SDE download (fallback) ─────────────────────────────────────────────────

async function downloadSde(): Promise<string | null> {
  console.log('Downloading EVE SDE...');
  const res = await fetch(SDE_URL);
  if (!res.ok || !res.body) throw new Error(`SDE download failed: ${res.status}`);

  const total    = parseInt(res.headers.get('content-length') ?? '0');
  let received   = 0;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      const mb  = (received / 1e6).toFixed(1);
      const pct = total ? ` ${Math.floor((received / total) * 100)}%` : '';
      process.stdout.write(`\r  ${mb} MB${pct}  `);
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body as any), progress, createWriteStream(SDE_ZIP));
  console.log('\n  done');
  // res.url is the final URL after CCP's redirect — it embeds the build number.
  return parseBuild(res.url);
}

// ─── WH seed loader ──────────────────────────────────────────────────────────

function loadWhSystems(): Map<number, WhData> {
  const lines = readFileSync(join(DATA_DIR, 'wormhole_systems.csv'), 'utf8')
    .split('\n').slice(1);

  const map = new Map<number, WhData>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols    = parseCSV(line);
    const id      = parseInt(cols[1]);
    const classId = parseInt(cols[4]);
    if (!id || !classId) continue;
    map.set(id, {
      class:   WH_CLASS[classId] ?? `C${classId}`,
      effect:  EFFECT_MAP[cols[5]?.trim()] ?? null,
      statics: (cols[6] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    });
  }
  console.log(`Loaded ${map.size} wormhole systems from seed`);
  return map;
}

// ─── Importers ───────────────────────────────────────────────────────────────

async function importRegions(zip: Zip): Promise<Map<number, number>> {
  process.stdout.write('Importing regions... ');
  const lines  = await readJsonl(zip, 'mapRegions.jsonl');
  // Build constellation→region map from constellation data (need region IDs from constellations)
  // Also build region rows for insert
  const rows: [number, string][] = [];
  const constellationRegion = new Map<number, number>();

  // We'll populate constellationRegion in importConstellations; here just collect regions
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key) continue;
      rows.push([o._key, o.name?.en ?? '']);
    } catch { /* skip */ }
  }

  await batchUpsert(
    'map_regions',
    ['id', 'name'],
    'id',
    rows.map(([id, name]) => [id, name]),
    500,
  );
  console.log(`${rows.length} regions`);
  return constellationRegion; // populated in importConstellations below
}

async function importConstellations(zip: Zip, constellationRegion: Map<number, number>) {
  process.stdout.write('Importing constellations... ');
  const lines = await readJsonl(zip, 'mapConstellations.jsonl');
  const rows: [number, string, number][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key || !o.regionID) continue;
      constellationRegion.set(o._key, o.regionID);
      rows.push([o._key, o.name?.en ?? '', o.regionID]);
    } catch { /* skip */ }
  }

  await batchUpsert(
    'map_constellations',
    ['id', 'name', 'region_id'],
    'id',
    rows,
    500,
  );
  console.log(`${rows.length} constellations`);
}

async function importSolarSystems(zip: Zip, whMap: Map<number, WhData>, constellationRegion: Map<number, number>) {
  process.stdout.write('Importing solar systems... ');
  const lines   = await readJsonl(zip, 'mapSolarSystems.jsonl');
  const systems: [number, string, number, number|null, number|null, string|null, string|null, string[], number|null, number|null, number|null, number|null, number|null, number][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const id       = o._key ?? 0;
      const name     = (o.name?.en ?? '') as string;
      const security = (o.securityStatus ?? 0) as number;
      if (!id || !name) continue;

      const constellationId = o.constellationID ?? null;
      const regionId        = constellationId ? (constellationRegion.get(constellationId) ?? null) : null;
      const wh              = whMap.get(id);
      // `position` is the {x, y, z} universe coordinate in metres; `position2D`
      // is CCP's flattened star-map projection used for region map layouts.
      const p               = o.position;
      const posX            = typeof p?.x === 'number' ? p.x : null;
      const posY            = typeof p?.y === 'number' ? p.y : null;
      const posZ            = typeof p?.z === 'number' ? p.z : null;
      const p2              = o.position2D;
      const pos2dX          = typeof p2?.x === 'number' ? p2.x : null;
      const pos2dY          = typeof p2?.y === 'number' ? p2.y : null;
      // Planet count is right here in the system record — no extra file needed.
      const planetCount     = Array.isArray(o.planetIDs) ? o.planetIDs.length : 0;

      systems.push([
        id, name, security,
        constellationId, regionId,
        wh?.class   ?? deriveClass(security, name),
        wh?.effect  ?? null,
        wh?.statics ?? [],
        posX, posY, posZ, pos2dX, pos2dY,
        planetCount,
      ]);
    } catch { /* skip */ }
  }

  const BATCH = 500;
  for (let i = 0; i < systems.length; i += BATCH) {
    const batch  = systems.slice(i, i + BATCH);
    const cols   = 14;
    const values = batch.map((_, j) =>
      `(${Array.from({ length: cols }, (_, k) => `$${j*cols+k+1}`).join(',')})`
    ).join(',');

    await db.query(
      `INSERT INTO solar_systems (id, name, security, constellation_id, region_id, class, effect, statics, pos_x, pos_y, pos_z, pos2d_x, pos2d_y, planet_count)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET
         name             = EXCLUDED.name,
         security         = EXCLUDED.security,
         constellation_id = EXCLUDED.constellation_id,
         region_id        = EXCLUDED.region_id,
         class            = EXCLUDED.class,
         effect           = EXCLUDED.effect,
         statics          = EXCLUDED.statics,
         pos_x            = EXCLUDED.pos_x,
         pos_y            = EXCLUDED.pos_y,
         pos_z            = EXCLUDED.pos_z,
         pos2d_x          = EXCLUDED.pos2d_x,
         pos2d_y          = EXCLUDED.pos2d_y,
         planet_count     = EXCLUDED.planet_count`,
      batch.flatMap(s => s),
    );
    process.stdout.write(`\r  ${Math.min(i + BATCH, systems.length)} / ${systems.length}  `);
  }
  console.log(`\n  ${systems.length} solar systems`);
}

// Reads mapStars.jsonl and writes two things back onto solar_systems:
//   • is_a0   — true for the "Sun A0 (Blue Small)" star (typeID 3801), drives
//               the ★ node icon. Reset-then-set so a re-seed reflects the latest
//               classification exactly (no stale flags if CCP reclassifies).
//   • sun_type — the star's item_types name (e.g. "Sun K3 (Yellow Small)"),
//               shown in the system-info panel. Resolved via a join on the
//               star's typeID, so this MUST run after importTypes.
async function importStars(zip: Zip) {
  process.stdout.write('Importing stars (A0 flags + sun types)... ');
  const lines = await readJsonl(zip, 'mapStars.jsonl');
  const a0Ids: number[]   = [];
  const sysIds: number[]  = [];
  const typeIds: number[] = [];
  for (const line of lines) {
    try {
      const o   = JSON.parse(line);
      const sys = o.solarSystemID as number | undefined;
      const typ = o.typeID as number | undefined;
      if (!sys) continue;
      if (typ === 3801) a0Ids.push(sys);
      if (typ) { sysIds.push(sys); typeIds.push(typ); }
    } catch { /* skip */ }
  }

  await db.query('UPDATE solar_systems SET is_a0 = FALSE WHERE is_a0 = TRUE');
  if (a0Ids.length) {
    await db.query('UPDATE solar_systems SET is_a0 = TRUE WHERE id = ANY($1::int[])', [a0Ids]);
  }

  // Resolve typeID → item_types.name and stamp sun_type. Batched so the
  // unnested parameter arrays stay a sane size.
  let sunSet = 0;
  const B = 2000;
  for (let i = 0; i < sysIds.length; i += B) {
    const r = await db.query(
      `UPDATE solar_systems s
          SET sun_type = it.name
         FROM (SELECT unnest($1::int[]) AS sys, unnest($2::int[]) AS typ) m
         JOIN item_types it ON it.id = m.typ
        WHERE s.id = m.sys`,
      [sysIds.slice(i, i + B), typeIds.slice(i, i + B)],
    );
    sunSet += r.rowCount ?? 0;
  }
  console.log(`${a0Ids.length} A0, ${sunSet} sun types`);
}

// Per-system celestial counts for the system-info panel. planet_count is set
// inline by importSolarSystems; this fills moon_count + belt_count (tallied
// from the mapMoons / mapAsteroidBelts records, which are large — hundreds of
// thousands of rows — so we extract solarSystemID with a regex instead of
// JSON.parse) and stargate_count (straight from the already-imported gates).
// Runs after importStargates. All static, so it only re-runs on a re-seed.
async function importCelestialCounts(zip: Zip) {
  process.stdout.write('Counting celestials (moons, belts, gates)... ');
  const moonCounts = tallyBySystem(await readJsonl(zip, 'mapMoons.jsonl'));
  await applyCounts('moon_count', moonCounts);
  const beltCounts = tallyBySystem(await readJsonl(zip, 'mapAsteroidBelts.jsonl'));
  await applyCounts('belt_count', beltCounts);

  await db.query(`
    UPDATE solar_systems s
       SET stargate_count = c.n
      FROM (SELECT system_id, COUNT(*)::int AS n FROM map_stargates GROUP BY system_id) c
     WHERE s.id = c.system_id`);

  // Systems with no moons / belts / gates should read 0 (seeded), not NULL
  // (which the panel treats as "fall back to ESI"). planet_count is already
  // non-null for every system from importSolarSystems.
  await db.query(`
    UPDATE solar_systems
       SET moon_count     = COALESCE(moon_count, 0),
           belt_count     = COALESCE(belt_count, 0),
           stargate_count = COALESCE(stargate_count, 0)`);
  console.log(`${moonCounts.size} w/ moons, ${beltCounts.size} w/ belts`);
}

// Flags shattered systems on solar_systems.shattered. A system is shattered
// when every one of its planets is "Planet (Shattered)" (typeID 30889) — this
// cleanly captures the C13 frigate holes, the Drifter wormholes and the
// shattered C1-C6 variants, while excluding normal systems that merely contain
// a single shattered planet among ordinary ones (e.g. J164104). mapPlanets is
// only ~21k records, so a JSON.parse per line is fine. Reset-then-set so a
// re-seed reflects the latest classification with no stale flags. Drives the
// fragments node icon via GET /api/systems/shattered.
const SHATTERED_PLANET_TYPE = 30889;
async function importShattered(zip: Zip) {
  process.stdout.write('Flagging shattered systems... ');
  const lines = await readJsonl(zip, 'mapPlanets.jsonl');
  const total     = new Map<number, number>();
  const shattered = new Map<number, number>();
  for (const line of lines) {
    try {
      const o   = JSON.parse(line);
      const sys = o.solarSystemID as number | undefined;
      if (!sys) continue;
      total.set(sys, (total.get(sys) ?? 0) + 1);
      if (o.typeID === SHATTERED_PLANET_TYPE) {
        shattered.set(sys, (shattered.get(sys) ?? 0) + 1);
      }
    } catch { /* skip */ }
  }

  const ids: number[] = [];
  for (const [sys, n] of total) {
    if (n > 0 && shattered.get(sys) === n) ids.push(sys);
  }

  await db.query('UPDATE solar_systems SET shattered = FALSE WHERE shattered = TRUE');
  if (ids.length) {
    await db.query('UPDATE solar_systems SET shattered = TRUE WHERE id = ANY($1::int[])', [ids]);
  }
  console.log(`${ids.length} shattered`);
}

// Tally records by their solarSystemID. Pulls the id out with a regex to skip
// JSON.parse over the giant moon/belt files; falls back to a parse on a miss.
function tallyBySystem(lines: string[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const m   = line.match(/"solarSystemID":\s*(\d+)/);
    let   sys = m ? parseInt(m[1], 10) : 0;
    if (!sys) { try { sys = JSON.parse(line).solarSystemID ?? 0; } catch { sys = 0; } }
    if (sys) counts.set(sys, (counts.get(sys) ?? 0) + 1);
  }
  return counts;
}

// Bulk-write a single count column from a system→count map. `col` is a
// hard-coded literal (never user input), so interpolating it is safe.
async function applyCounts(col: 'moon_count' | 'belt_count', counts: Map<number, number>) {
  const sysIds = Array.from(counts.keys());
  const vals   = Array.from(counts.values());
  const B = 2000;
  for (let i = 0; i < sysIds.length; i += B) {
    await db.query(
      `UPDATE solar_systems s
          SET ${col} = m.n
         FROM (SELECT unnest($1::int[]) AS sys, unnest($2::int[]) AS n) m
        WHERE s.id = m.sys`,
      [sysIds.slice(i, i + B), vals.slice(i, i + B)],
    );
  }
}

async function importStargates(zip: Zip) {
  process.stdout.write('Importing stargates... ');
  const lines = await readJsonl(zip, 'mapStargates.jsonl');
  const rows: [number, number, number, number][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key || !o.solarSystemID || !o.destination) continue;
      rows.push([o._key, o.solarSystemID, o.destination.stargateID, o.destination.solarSystemID]);
    } catch { /* skip */ }
  }

  await batchUpsert('map_stargates',
    ['id', 'system_id', 'destination_gate_id', 'destination_system_id'],
    'id', rows, 1000);
  console.log(`${rows.length} stargates`);
}

async function importCategories(zip: Zip) {
  process.stdout.write('Importing item categories... ');
  const lines = await readJsonl(zip, 'categories.jsonl');
  const rows: [number, string, boolean][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o._key === undefined) continue;
      rows.push([o._key, o.name?.en ?? '', o.published ?? false]);
    } catch { /* skip */ }
  }

  await batchUpsert('item_categories', ['id', 'name', 'published'], 'id', rows, 500);
  console.log(`${rows.length} categories`);
}

async function importGroups(zip: Zip) {
  process.stdout.write('Importing item groups... ');
  const lines = await readJsonl(zip, 'groups.jsonl');
  const rows: [number, string, number, boolean][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o._key === undefined || o.categoryID === undefined) continue;
      rows.push([o._key, o.name?.en ?? '', o.categoryID, o.published ?? false]);
    } catch { /* skip */ }
  }

  await batchUpsert('item_groups', ['id', 'name', 'category_id', 'published'], 'id', rows, 500);
  console.log(`${rows.length} groups`);
}

async function importTypes(zip: Zip) {
  process.stdout.write('Importing item types... ');
  const lines = await readJsonl(zip, 'types.jsonl');
  const rows: [number, string, number, number|null, number|null, string|null, boolean][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o._key === undefined || o.groupID === undefined) continue;
      rows.push([
        o._key,
        o.name?.en ?? '',
        o.groupID,
        o.mass   ?? null,
        o.volume ?? null,
        o.description?.en ?? null,
        o.published ?? false,
      ]);
    } catch { /* skip */ }
  }

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch  = rows.slice(i, i + BATCH);
    const cols   = 7;
    const values = batch.map((_, j) =>
      `($${j*cols+1},$${j*cols+2},$${j*cols+3},$${j*cols+4},$${j*cols+5},$${j*cols+6},$${j*cols+7})`
    ).join(',');
    await db.query(
      `INSERT INTO item_types (id, name, group_id, mass, volume, description, published)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET
         name        = EXCLUDED.name,
         group_id    = EXCLUDED.group_id,
         mass        = EXCLUDED.mass,
         volume      = EXCLUDED.volume,
         description = EXCLUDED.description,
         published   = EXCLUDED.published`,
      batch.flatMap(r => r),
    );
    process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)} / ${rows.length}  `);
  }
  console.log(`\n  ${rows.length} types`);
}

async function importDogmaAttributes(zip: Zip) {
  process.stdout.write('Importing dogma attributes... ');
  const lines = await readJsonl(zip, 'dogmaAttributes.jsonl');
  const rows: [number, string, string|null, boolean, boolean][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o._key === undefined) continue;
      rows.push([
        o._key,
        o.name ?? '',
        o.description ?? null,
        o.highIsGood  ?? true,
        o.stackable   ?? true,
      ]);
    } catch { /* skip */ }
  }

  await batchUpsert('dogma_attributes',
    ['id', 'name', 'description', 'high_is_good', 'stackable'],
    'id', rows, 500);
  console.log(`${rows.length} attributes`);
}

async function importItemDogma(zip: Zip) {
  process.stdout.write('Importing item dogma... ');
  const lines = await readJsonl(zip, 'typeDogma.jsonl');
  const rows: [number, number, number][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key || !Array.isArray(o.dogmaAttributes)) continue;
      for (const attr of o.dogmaAttributes) {
        if (attr.attributeID === undefined || attr.value === undefined) continue;
        rows.push([o._key, attr.attributeID, attr.value]);
      }
    } catch { /* skip */ }
  }

  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch  = rows.slice(i, i + BATCH);
    const values = batch.map((_, j) => `($${j*3+1},$${j*3+2},$${j*3+3})`).join(',');
    await db.query(
      `INSERT INTO item_dogma_attributes (type_id, attribute_id, value)
       VALUES ${values}
       ON CONFLICT (type_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
      batch.flatMap(r => r),
    );
    process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)} / ${rows.length}  `);
  }
  console.log(`\n  ${rows.length} dogma rows`);
}

async function importFactions(zip: Zip) {
  process.stdout.write('Importing factions... ');
  const lines = await readJsonl(zip, 'factions.jsonl');
  const rows: [number, string][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key) continue;
      rows.push([o._key, o.name?.en ?? o.uniqueName ?? '']);
    } catch { /* skip */ }
  }

  await batchUpsert('factions', ['id', 'name'], 'id', rows, 500);
  console.log(`${rows.length} factions`);
}

async function importMetaGroups(zip: Zip) {
  process.stdout.write('Importing meta groups... ');
  const lines = await readJsonl(zip, 'metaGroups.jsonl');
  const rows: [number, string][] = [];

  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o._key) continue;
      rows.push([o._key, o.name?.en ?? '']);
    } catch { /* skip */ }
  }

  await batchUpsert('meta_groups', ['id', 'name'], 'id', rows, 500);
  console.log(`${rows.length} meta groups`);
}

async function seedRegionNpcTypes() {
  process.stdout.write('Seeding region NPC types... ');

  // Region name (as stored in DB, without "Map" prefix) → NPC rat type
  const npcTypes: [string, string][] = [
    // Empire regions
    ['Aridia',            'Blood Raiders'],
    ['Black Rise',        'Guristas'],
    ['The Bleak Lands',   'Blood Raiders'],
    ['The Citadel',       'Guristas'],
    ['Derelik',           'Sansha'],
    ['Devoid',            'Sansha'],
    ['Domain',            'Sansha'],
    ['Essence',           'Serpentis'],
    ['Everyshore',        'Serpentis'],
    ['The Forge',         'Guristas'],
    ['Genesis',           'Blood Raiders'],
    ['Heimatar',          'Angels'],
    ['Kador',             'Blood Raiders'],
    ['Khanid',            'Blood Raiders'],
    ['Kor-Azor',          'Blood Raiders'],
    ['Lonetrek',          'Guristas'],
    ['Metropolis',        'Angels'],
    ['Molden Heath',      'Angels'],
    ['Placid',            'Serpentis'],
    ['Sinq Laison',       'Serpentis'],
    ['Solitude',          'Serpentis'],
    ['Tash-Murkon',       'Sansha'],
    ['Verge Vendor',      'Serpentis'],
    // Null sec
    ['Branch',            'Guristas'],
    ['Cache',             'Angels'],
    ['Catch',             'Sansha'],
    ['Cloud Ring',        'Serpentis'],
    ['Cobalt Edge',       'Drones'],
    ['Curse',             'Angels'],
    ['Deklein',           'Guristas'],
    ['Delve',             'Blood Raiders'],
    ['Detorid',           'Angels'],
    ['Esoteria',          'Sansha'],
    ['Etherium Reach',    'Drones'],
    ['Fade',              'Serpentis'],
    ['Feythabolis',       'Angels'],
    ['Fountain',          'Serpentis'],
    ['Geminate',          'Guristas'],
    ['Great Wildlands',   'Angels'],
    ['Immensea',          'Angels'],
    ['Impass',            'Angels'],
    ['Insmother',         'Angels'],
    ['The Kalevala Expanse', 'Drones'],
    ['Malpais',           'Drones'],
    ['Oasa',              'Drones'],
    ['Omist',             'Angels'],
    ['Outer Passage',     'Drones'],
    ['Outer Ring',        'Serpentis'],
    ['Paragon Soul',      'Sansha'],
    ['Period Basis',      'Blood Raiders'],
    ['Perrigen Falls',    'Drones'],
    ['Pochven',           'Triglavian'],
    ['Providence',        'Sansha'],
    ['Pure Blind',        'Guristas'],
    ['Querious',          'Blood Raiders'],
    ['Scalding Pass',     'Angels'],
    ['The Spire',         'Drones'],
    ['Stain',             'Sansha'],
    ['Syndicate',         'Serpentis'],
    ['Tenal',             'Guristas'],
    ['Tenerifis',         'Angels'],
    ['Tribute',           'Guristas'],
    ['Vale of the Silent','Guristas'],
    ['Venal',             'Guristas'],
    ['Wicked Creek',      'Angels'],
  ];

  for (const [name, npcType] of npcTypes) {
    await db.query(
      `UPDATE map_regions SET npc_type = $1 WHERE name = $2`,
      [npcType, name],
    );
  }

  console.log(`${npcTypes.length} regions updated`);
}

// ─── Shared utilities ────────────────────────────────────────────────────────

async function readJsonl(zip: Zip, filename: string): Promise<string[]> {
  const entry = zip.files.find(f => f.path === filename);
  if (!entry) throw new Error(`${filename} not found in SDE zip`);
  const buf = await entry.buffer();
  return buf.toString('utf8').split('\n').filter(l => l.trim());
}

async function batchUpsert(
  table:   string,
  columns: string[],
  pk:      string,
  rows:    unknown[][],
  batchSz: number,
) {
  const n = columns.length;
  for (let i = 0; i < rows.length; i += batchSz) {
    const batch  = rows.slice(i, i + batchSz);
    const values = batch.map((_, j) =>
      `(${columns.map((_, k) => `$${j*n+k+1}`).join(',')})`
    ).join(',');
    const updates = columns
      .filter(c => c !== pk)
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');
    await db.query(
      `INSERT INTO ${table} (${columns.join(',')})
       VALUES ${values}
       ON CONFLICT (${pk}) DO UPDATE SET ${updates}`,
      batch.flatMap(r => r),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveClass(security: number, name: string): string {
  if (name === 'Thera') return 'Thera';
  if (security >= 0.45) return 'HS';
  if (security > 0)     return 'LS';
  return 'NS';
}

function parseCSV(line: string): string[] {
  const cols: string[] = [];
  let cur = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"')                    { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes)  { cols.push(cur); cur = ''; }
    else                               { cur += ch; }
  }
  cols.push(cur);
  return cols;
}

main().catch(err => { console.error(err); process.exit(1); });
