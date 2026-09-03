// Shared harness for the DB-integration suites: connects to the throwaway `*_test`
// database (redirected by vitest.setup.ts), builds the real schema via migrate(),
// and provides truncate + seed helpers. Runs the REAL SQL — nothing here is
// mocked — so it catches authz bugs that the mocked-db unit tests cannot.
//
// If the test DB is unreachable, ensureIntegrationDb() returns false and the
// suites skip (describe.skipIf) rather than fail — so `yarn test` still runs the
// unit suites on a machine with no Postgres. CI provides the DB, so they run there.
import { db } from '../db.js';
import { migrate } from '../migrate.js';

// connect-pg-simple creates its session table lazily on first login; migrate()
// doesn't. revalidateActiveSessions() reads sessions.sess->>'userId' + .expire,
// so build a matching table for the tests.
const SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    sid    varchar     NOT NULL PRIMARY KEY,
    sess   json        NOT NULL,
    expire timestamp(6) NOT NULL
  );`;

// solar_systems / map_regions come from the SDE importer (setup-db), not from
// migrate(), so a test database has neither — and any route that joins them
// (account-locations, pilots-online, the region reads) 500s with "relation does
// not exist". Created here with the same shape setup-db uses, left EMPTY: suites
// that need a system seed one, and everything else behaves exactly as before
// against a table with no rows.
//
// The column list matters. A narrower stub is worse than nothing: migrate()'s
// SDE sync sees the table exist and then fails on the columns it's missing,
// which breaks every suite rather than one.
const SDE_DDL = `
  CREATE TABLE IF NOT EXISTS map_regions (
    id       INTEGER PRIMARY KEY,
    name     TEXT,
    npc_type TEXT
  );
  CREATE TABLE IF NOT EXISTS solar_systems (
    id               INTEGER      PRIMARY KEY,
    name             TEXT         NOT NULL,
    security         NUMERIC(6,4) NOT NULL DEFAULT 0,
    class            TEXT,
    effect           TEXT,
    statics          TEXT[]       NOT NULL DEFAULT '{}',
    constellation_id INTEGER,
    region_id        INTEGER,
    shattered        BOOLEAN      NOT NULL DEFAULT FALSE,
    pos_x            DOUBLE PRECISION,
    pos_y            DOUBLE PRECISION,
    pos_z            DOUBLE PRECISION,
    pos2d_x          DOUBLE PRECISION,
    pos2d_y          DOUBLE PRECISION
  );`;

let ready: Promise<boolean> | null = null;

export function ensureIntegrationDb(): Promise<boolean> {
  if (!ready) {
    ready = (async () => {
      try {
        await db.query('SELECT 1');
      } catch {
        return false; // no test DB reachable — suites skip
      }
      await migrate();
      await db.query(SESSIONS_DDL);
      await db.query(SDE_DDL);
      return true;
    })();
  }
  return ready;
}

const TABLES = [
  'solar_systems', 'map_regions',
  'access_grants', 'app_settings', 'map_shares', 'maps',
  'corp_standings', 'alliance_standings', 'character_standings',
  'standings_refresh', 'entity_names', 'sessions', 'user_events', 'users',
];

export async function truncateAll(): Promise<void> {
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface SeedUser {
  characterId: number;
  corpId?:     number | null;
  allianceId?: number | null;
  role?:       string;
  blocked?:    boolean;
  name?:       string;
}

// Insert a user row (most columns default) and return its generated id.
export async function seedUser(u: SeedUser): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (character_id, character_name, role, corp_id, alliance_id, blocked)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [u.characterId, u.name ?? `Pilot ${u.characterId}`, u.role ?? 'readonly',
     u.corpId ?? null, u.allianceId ?? null, u.blocked ?? false],
  );
  return rows[0].id;
}

let sidCounter = 0;

// Insert a session row for a user. Live by default; { expired: true } sets an
// expiry in the past so the revalidation scan (WHERE expire > NOW()) skips it.
export async function seedSession(userId: number, opts: { expired?: boolean } = {}): Promise<string> {
  const sid = `test-sid-${userId}-${++sidCounter}`;
  const expireExpr = opts.expired ? `NOW() - INTERVAL '1 hour'` : `NOW() + INTERVAL '1 day'`;
  await db.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::json, ${expireExpr})`,
    [sid, JSON.stringify({ userId })],
  );
  return sid;
}

export async function liveSessionCount(userId: number): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM sessions WHERE (sess->>'userId')::int = $1`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}
