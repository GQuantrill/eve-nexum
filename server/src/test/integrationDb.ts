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
      return true;
    })();
  }
  return ready;
}

const TABLES = [
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
