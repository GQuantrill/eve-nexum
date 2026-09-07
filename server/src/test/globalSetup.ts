// Runs ONCE per `yarn test` invocation (vitest globalSetup), in the main process
// — before any worker, and separately from vitest.setup.ts.
//
// Why this exists: every integration suite shares ONE `*_test` database and
// TRUNCATEs it between tests. Nothing stopped two test runs from overlapping on
// the same machine (a stray `yarn test` still finishing, a backgrounded run, two
// terminals), and when they do, each run's TRUNCATE wipes the other's fixtures
// mid-request. That surfaces as failures scattered across unrelated suites — or,
// when the overlap is brief, as a SINGLE assertion failing for no visible reason
// and passing on the next run. It reads exactly like a flaky test and isn't one.
//
// So: take a session-level advisory lock for the whole run. A second concurrent
// run fails immediately with an explanation instead of silently corrupting both.
// The lock is held by a dedicated connection, so it cannot go stale — if the run
// crashes or is killed, the connection drops and Postgres releases it.
//
// CI is unaffected: each job has its own database and the lock is always free.
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';

// Arbitrary but fixed key, scoped per database — the lock only collides with
// another run against the same test DB.
const LOCK_KEY = 0x6e78_7401; // "nxt" + 1

let holder: Client | null = null;

export async function setup(): Promise<void> {
  loadDotenv();

  // Mirror vitest.setup.ts's redirect: guard the same database the workers use.
  const current = process.env.PG_DB ?? 'eve_nexum';
  const database = process.env.PG_TEST_DB ?? (current.endsWith('_test') ? current : `${current}_test`);

  const client = new Client({
    host:     process.env.PG_HOST ?? 'localhost',
    port:     parseInt(process.env.PG_PORT ?? '5432'),
    database,
    user:     process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await client.connect();
  } catch {
    // No test DB reachable. The integration suites already skip in that case
    // (ensureIntegrationDb returns false), so there is nothing to guard.
    await client.end().catch(() => {});
    return;
  }

  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY],
  );

  if (!rows[0].locked) {
    await client.end().catch(() => {});
    throw new Error(
      `Another test run is already using the "${database}" database.\n` +
      'The integration suites TRUNCATE shared tables, so two runs at once corrupt each\n' +
      "other's fixtures and fail in unrelated places. Wait for the other run to finish\n" +
      '(or kill it: pkill -f vitest) and try again.',
    );
  }

  holder = client; // hold the connection — and the lock — for the whole run
}

export async function teardown(): Promise<void> {
  if (!holder) return;
  // Ending the connection releases the advisory lock; unlock first so the intent
  // is explicit rather than a side effect of disconnecting.
  await holder.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  await holder.end().catch(() => {});
  holder = null;
}
