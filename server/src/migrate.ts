import { db } from './db.js';
import { encryptToken, isEncrypted } from './utils/tokenCrypto.js';

// One-shot pass that re-encrypts any plaintext OAuth tokens left in the
// `users` table. Idempotent: rows already prefixed with `enc:v1:` are
// skipped. Safe to run on every boot.
async function encryptLegacyTokens() {
  const { rows } = await db.query<{ id: number; access_token: string | null; refresh_token: string | null }>(
    `SELECT id, access_token, refresh_token FROM users
     WHERE (access_token IS NOT NULL AND access_token NOT LIKE 'enc:v1:%')
        OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:%')`,
  );
  if (!rows.length) return;
  for (const row of rows) {
    const at = row.access_token && !isEncrypted(row.access_token)  ? encryptToken(row.access_token)  : row.access_token;
    const rt = row.refresh_token && !isEncrypted(row.refresh_token) ? encryptToken(row.refresh_token) : row.refresh_token;
    await db.query(`UPDATE users SET access_token = $1, refresh_token = $2 WHERE id = $3`, [at, rt, row.id]);
  }
  console.log(`Encrypted OAuth tokens for ${rows.length} legacy user row(s)`);
}

export async function migrate() {
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS compact_mode  BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS snap_to_grid  BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_minimap  BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS uniform_size  BOOLEAN NOT NULL DEFAULT TRUE;

    -- One-time: uniform_size shipped with a FALSE default originally;
    -- product decision later was that ON should be the out-of-the-box
    -- behaviour. Flip every existing FALSE row to TRUE and update the
    -- column default. Idempotent via the column-default sentinel: once
    -- the default is already TRUE, the inner block is skipped, so a user
    -- who later toggles OFF stays OFF.
    DO $uniform$
    BEGIN
      IF (SELECT column_default FROM information_schema.columns
           WHERE table_name = 'users' AND column_name = 'uniform_size') = 'false' THEN
        UPDATE users SET uniform_size = TRUE WHERE uniform_size = FALSE;
        ALTER TABLE users ALTER COLUMN uniform_size SET DEFAULT TRUE;
      END IF;
    END
    $uniform$;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_statics  BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS connection_thickness TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS route_mode           TEXT NOT NULL DEFAULT 'shortest';
    -- route_include_bridges backed the removed Ansiblex jump-bridge routing.
    ALTER TABLE users DROP COLUMN IF EXISTS route_include_bridges;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_zoom NUMERIC(3,2) NOT NULL DEFAULT 1.00;

    -- Cross-device UI settings (sidebar order, panel collapsed states,
    -- closestSystems list, etc). One opaque JSONB blob so we do not add
    -- a column per setting. Client-side useUserSetting(key, default)
    -- hook reads from /auth/me and PATCHes via /auth/settings.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Removed: ansiblex_bridges backed the Ansiblex jump-bridge routing,
    -- which was derived from the (also removed) structure auto-discovery.
    DROP TABLE IF EXISTS ansiblex_bridges;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS panel_order   TEXT[]  NOT NULL DEFAULT '{notes,signatures,structures,npcStations}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role          TEXT    NOT NULL DEFAULT 'readonly';
    UPDATE users SET role = 'readonly' WHERE role = 'standard';
    -- Multi-corp + new role model: 'member' (old trusted role) → 'full' (can
    -- create / delete maps). New roles 'edit' (per-system edits only) and
    -- 'readonly' remain. 'admin' is unchanged.
    UPDATE users SET role = 'full' WHERE role = 'member';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS corp_id INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS maps (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT        NOT NULL DEFAULT 'New Map',
      corp_id        INTEGER,
      locked         BOOLEAN     NOT NULL DEFAULT FALSE,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS corp_id        INTEGER;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS locked         BOOLEAN     NOT NULL DEFAULT FALSE;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    -- Read-only share links. Token is the only thing in the URL; the
    -- expiry column is the source of truth for "still valid" — a NULL
    -- token means sharing has been revoked outright.
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_token      UUID;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ;
    -- Per-link inclusion flags. The owner picks these when they generate
    -- the link; live-PATCHable while a token is active. Defaults are
    -- FALSE so a freshly-created link starts with everything intel-free
    -- and the owner explicitly opts each category in.
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_include_sigs       BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_include_bridges    BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_include_notes      BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS share_include_structures BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE maps ALTER COLUMN share_include_sigs    SET DEFAULT FALSE;
    ALTER TABLE maps ALTER COLUMN share_include_bridges SET DEFAULT FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_maps_share_token ON maps (share_token) WHERE share_token IS NOT NULL;

    -- Corp maps can opt in to being used as the *source* of a map merge.
    -- Default FALSE: a corp map stays private to its corp until a full/admin
    -- member explicitly enables it. Solo maps ignore this flag — their owner
    -- and share recipients can always merge from them.
    ALTER TABLE maps ADD COLUMN IF NOT EXISTS allow_as_merge_source BOOLEAN NOT NULL DEFAULT FALSE;

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
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS wh_type   TEXT;
    ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS mass_used BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS eol_at    TIMESTAMPTZ;
    ALTER TABLE map_systems     ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    -- Manual intel tag a user can apply to a system via right-click. Distinct
    -- from status (which is exploration state -- visited / cleared) -- this
    -- is who-is-home intel: friendly, hostile, occupied (neutral residents),
    -- empty. NULL means no tag.
    ALTER TABLE map_systems     ADD COLUMN IF NOT EXISTS intel TEXT;

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
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      system_id      UUID        NOT NULL REFERENCES map_systems(id) ON DELETE CASCADE,
      name           TEXT        NOT NULL DEFAULT '',
      structure_type TEXT        NOT NULL DEFAULT 'unknown',
      owner_corp     TEXT        NOT NULL DEFAULT '',
      eve_id         BIGINT,
      notes          TEXT        NOT NULL DEFAULT '',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Attribute sigs and structures to the user who created them, so the
    -- admin Users report can answer "last time X added a sig/struct on a
    -- corp map". Nullable: rows created before this migration stay NULL,
    -- and we deliberately ON DELETE SET NULL so dropping a user doesn't
    -- nuke the rows they touched.
    ALTER TABLE map_signatures ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE map_structures ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    -- Resolved owner corp ID for structures. Populated by ESI lookup when
    -- the user supplies an eve_id (the structure's in-game ID) or when
    -- the structure name parser finds a known corp/alliance. Lets the
    -- structures pane apply standings-based tints per row.
    ALTER TABLE map_structures ADD COLUMN IF NOT EXISTS owner_corp_id INTEGER;

    -- Removed: known_structures was the cluster-wide cache of structures
    -- auto-discovered via corp ESI / a public dataset. The feature (and the
    -- Ansiblex routing derived from it) has been dropped; manual per-map
    -- structures live in map_structures and are unaffected.
    DROP TABLE IF EXISTS known_structures;

    CREATE TABLE IF NOT EXISTS user_events (
      id          BIGSERIAL   PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type  TEXT        NOT NULL,
      sig_type    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Track which map a user_event belongs to, so the admin Users report
    -- can scope counts to corp maps. Nullable for compatibility with rows
    -- created before this migration; no FK because we want events to
    -- survive even after the map is force-deleted.
    ALTER TABLE user_events ADD COLUMN IF NOT EXISTS map_id UUID;

    -- Cluster-wide log of K-space systems where a Covert Research Facility
    -- signature ("Ghost site") has been observed. One row per system, with
    -- observation count + first/last seen for spawn-rate analysis. Static
    -- columns (sun_type, planet/moon counts) are filled once via ESI on
    -- first detection — they never change.
    CREATE TABLE IF NOT EXISTS ghost_site_systems (
      eve_system_id      INTEGER     PRIMARY KEY,
      system_name        TEXT        NOT NULL,
      constellation_name TEXT,
      region_name        TEXT,
      system_class       TEXT        NOT NULL,
      sun_type           TEXT,
      planet_count       INTEGER,
      moon_count         INTEGER,
      observations       INTEGER     NOT NULL DEFAULT 1,
      first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_activity (
      eve_system_id INTEGER     NOT NULL,
      hour          TIMESTAMPTZ NOT NULL,
      jumps         INTEGER     NOT NULL DEFAULT 0,
      ship_kills    INTEGER     NOT NULL DEFAULT 0,
      pod_kills     INTEGER     NOT NULL DEFAULT 0,
      npc_kills     INTEGER     NOT NULL DEFAULT 0,
      PRIMARY KEY (eve_system_id, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_maps_user             ON maps (user_id);
    CREATE INDEX IF NOT EXISTS idx_map_systems_map       ON map_systems (map_id);

    -- Enforce one node per (map, eve_system). Run a one-shot dedup of any
    -- pre-existing duplicates first — re-point connections / sigs /
    -- structures at the survivor (oldest row wins), then drop the losers.
    -- The dedup is a no-op once the constraint is in place.
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM map_systems
        WHERE eve_system_id IS NOT NULL
        GROUP BY map_id, eve_system_id
        HAVING COUNT(*) > 1
      ) THEN
        CREATE TEMP TABLE _system_dups ON COMMIT DROP AS
        SELECT
          loser.id AS loser_id,
          winner.id AS winner_id
        FROM (
          SELECT id, map_id, eve_system_id,
                 ROW_NUMBER() OVER (PARTITION BY map_id, eve_system_id
                                    ORDER BY created_at, id) AS rn
          FROM map_systems WHERE eve_system_id IS NOT NULL
        ) loser
        JOIN (
          SELECT id, map_id, eve_system_id,
                 ROW_NUMBER() OVER (PARTITION BY map_id, eve_system_id
                                    ORDER BY created_at, id) AS rn
          FROM map_systems WHERE eve_system_id IS NOT NULL
        ) winner
          ON loser.map_id        = winner.map_id
         AND loser.eve_system_id = winner.eve_system_id
         AND winner.rn = 1
        WHERE loser.rn > 1;

        UPDATE map_connections SET source_id = d.winner_id
          FROM _system_dups d WHERE source_id = d.loser_id;
        UPDATE map_connections SET target_id = d.winner_id
          FROM _system_dups d WHERE target_id = d.loser_id;
        UPDATE map_signatures  SET system_id = d.winner_id
          FROM _system_dups d WHERE system_id = d.loser_id;
        UPDATE map_structures  SET system_id = d.winner_id
          FROM _system_dups d WHERE system_id = d.loser_id;

        -- A connection re-pointed onto itself is no longer a connection.
        DELETE FROM map_connections WHERE source_id = target_id;

        -- After re-pointing, two distinct connections may now point at the
        -- same (src,tgt) pair. Keep the oldest.
        DELETE FROM map_connections c
        WHERE EXISTS (
          SELECT 1 FROM map_connections c2
          WHERE c2.id <> c.id
            AND c2.map_id = c.map_id
            AND LEAST(c2.source_id, c2.target_id)    = LEAST(c.source_id, c.target_id)
            AND GREATEST(c2.source_id, c2.target_id) = GREATEST(c.source_id, c.target_id)
            AND c2.created_at < c.created_at
        );

        DELETE FROM map_systems WHERE id IN (SELECT loser_id FROM _system_dups);
      END IF;
    END
    $migration$;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_map_systems_eve_system
      ON map_systems (map_id, eve_system_id)
      WHERE eve_system_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_map_connections_map   ON map_connections (map_id);
    CREATE INDEX IF NOT EXISTS idx_map_signatures_system ON map_signatures (system_id);
    CREATE INDEX IF NOT EXISTS idx_map_structures_system ON map_structures (system_id);
    CREATE INDEX IF NOT EXISTS idx_user_events_user      ON user_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_system_activity       ON system_activity (eve_system_id, hour DESC);
    CREATE INDEX IF NOT EXISTS idx_system_activity_hour  ON system_activity (hour);
    CREATE INDEX IF NOT EXISTS idx_maps_last_active      ON maps (last_active_at) WHERE corp_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS admin_audit (
      id                  BIGSERIAL   PRIMARY KEY,
      actor_user_id       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      actor_character_id  BIGINT,
      target_user_id      INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      target_character_id BIGINT,
      action              TEXT        NOT NULL,
      old_value           TEXT,
      new_value           TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);

    -- Standings (player contacts). Three owner tables keyed by character /
    -- corp / alliance. Each row carries the standing (-10..+10) toward a
    -- specific (contact_kind, contact_id) target. Shared at corp/alliance
    -- level so one Contact-Manager pulling once benefits the whole corp.
    -- Personal character contacts stay per-character.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alliance_id INTEGER;

    CREATE TABLE IF NOT EXISTS character_standings (
      character_id  INTEGER     NOT NULL,
      contact_kind  TEXT        NOT NULL,
      contact_id    INTEGER     NOT NULL,
      standing      REAL        NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (character_id, contact_kind, contact_id)
    );

    CREATE TABLE IF NOT EXISTS corp_standings (
      corp_id            INTEGER     NOT NULL,
      contact_kind       TEXT        NOT NULL,
      contact_id         INTEGER     NOT NULL,
      standing           REAL        NOT NULL,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (corp_id, contact_kind, contact_id)
    );

    CREATE TABLE IF NOT EXISTS alliance_standings (
      alliance_id        INTEGER     NOT NULL,
      contact_kind       TEXT        NOT NULL,
      contact_id         INTEGER     NOT NULL,
      standing           REAL        NOT NULL,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (alliance_id, contact_kind, contact_id)
    );

    -- Tracks when we last *successfully* fetched standings for a given
    -- owner so we can throttle refreshes (and so we know whether a 403
    -- means "no role" vs "first ever fetch").
    CREATE TABLE IF NOT EXISTS standings_refresh (
      owner_kind      TEXT        NOT NULL,
      owner_id        INTEGER     NOT NULL,
      last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_kind, owner_id)
    );

    CREATE INDEX IF NOT EXISTS idx_char_standings_target     ON character_standings (contact_kind, contact_id);
    CREATE INDEX IF NOT EXISTS idx_corp_standings_target     ON corp_standings     (contact_kind, contact_id);
    CREATE INDEX IF NOT EXISTS idx_alliance_standings_target ON alliance_standings (contact_kind, contact_id);

    -- Cluster-wide name cache for EVE entities (characters, corps, alliances,
    -- and anything else ESI /universe/names/ returns). Populated lazily on
    -- demand by resolveEntityNames(); used to label killmails, standings,
    -- structure owners, etc. without paying the ESI cost every render.
    --
    -- Names are effectively immutable for chars/corps; alliances rename
    -- rarely. fetched_at lets callers apply a staleness policy if they care
    -- (most don't — a 30-day re-resolve is more than enough).
    CREATE TABLE IF NOT EXISTS entity_names (
      id          BIGINT      PRIMARY KEY,
      name        TEXT        NOT NULL,
      category    TEXT        NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Per-map grants of edit access to either an individual EVE character or
    -- an entire corp. Targets are stored as raw EVE IDs (not user_ids) so a
    -- share survives the recipient not having logged into Nexum yet — their
    -- first login resolves to a user row whose character_id matches.
    --
    -- Exactly one of target_character_id / target_corp_id is non-NULL; the
    -- CHECK enforces XOR. ON DELETE CASCADE on both map and granter so a
    -- deleted map / owner cleans up its grants automatically.
    CREATE TABLE IF NOT EXISTS map_shares (
      id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      map_id               UUID        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      target_character_id  INTEGER,
      target_corp_id       INTEGER,
      granted_by_user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((target_character_id IS NOT NULL) <> (target_corp_id IS NOT NULL))
    );
    -- One grant per (map, target). Partial unique indexes are easier than a
    -- single composite that has to deal with NULLs.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_map_shares_char ON map_shares (map_id, target_character_id) WHERE target_character_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_map_shares_corp ON map_shares (map_id, target_corp_id)      WHERE target_corp_id      IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_map_shares_char ON map_shares (target_character_id) WHERE target_character_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_map_shares_corp ON map_shares (target_corp_id)      WHERE target_corp_id      IS NOT NULL;
  `);

  await encryptLegacyTokens();
}
