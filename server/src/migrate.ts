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

    -- Cluster-wide cache of structures auto-discovered via ESI or imported
    -- from a public dataset. Distinct from map_structures (which is
    -- per-map and user-managed) -- these are read-only intel surfaced
    -- into the structures pane alongside the user's own entries.
    --
    -- source = 'corp-esi' or 'public-dataset'.
    --
    -- restricted_to_corp_id IS NOT NULL means "only members of that corp
    -- can see this row" -- used for the corp-ESI source so each corp
    -- only sees its own private citadel intel. Public-dataset rows have
    -- restricted_to_corp_id NULL.
    CREATE TABLE IF NOT EXISTS known_structures (
      structure_id          BIGINT      PRIMARY KEY,
      system_id             INTEGER     NOT NULL,
      owner_corp_id         INTEGER,
      alliance_id           INTEGER,
      name                  TEXT        NOT NULL DEFAULT '',
      type_id               INTEGER,
      source                TEXT        NOT NULL,
      restricted_to_corp_id INTEGER,
      first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_known_structures_system ON known_structures (system_id);
    CREATE INDEX IF NOT EXISTS idx_known_structures_corp   ON known_structures (restricted_to_corp_id);

    -- Track which map a user_event belongs to, so the admin Users report
    -- can scope counts to corp maps. Nullable for compatibility with rows
    -- created before this migration; no FK because we want events to
    -- survive even after the map is force-deleted.
    ALTER TABLE user_events ADD COLUMN IF NOT EXISTS map_id UUID;

    CREATE TABLE IF NOT EXISTS user_events (
      id          BIGSERIAL   PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type  TEXT        NOT NULL,
      sig_type    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  `);

  await encryptLegacyTokens();
}
