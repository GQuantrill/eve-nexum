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
  `);

  await encryptLegacyTokens();
}
