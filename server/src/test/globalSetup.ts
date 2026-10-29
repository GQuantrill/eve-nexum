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
//
// And when no test database is reachable at all -- the usual case on a laptop,
// where the dev Postgres runs inside Docker with no port published -- it starts
// its own: a throwaway postgres:16 container on a free local port, the same
// image CI uses, removed again at the end of the run. So a plain `yarn test`
// runs every suite, not just the ones that need no database. An explicit
// PG_* pointing at a reachable *_test database (CI, or your own container)
// still wins. NEXUM_TEST_DB=skip opts out and lets the integration suites skip.
import { config as loadDotenv } from 'dotenv';
import { Client, type ClientConfig } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Arbitrary but fixed key, scoped per database — the lock only collides with
// another run against the same test DB.
const LOCK_KEY = 0x6e78_7401; // "nxt" + 1

let holder: Client | null = null;

// The container this run started, if any -- removed in teardown.
let container: string | null = null;

const TEST_DB   = 'eve_nexum_test';
const TEST_USER = 'nexum';
const TEST_PASS = 'test'; // a throwaway container bound to 127.0.0.1 only

async function tryConnect(cfg: ClientConfig): Promise<Client | null> {
  const client = new Client({ ...cfg, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

// Start a throwaway Postgres and wait for it to take connections. Its details go
// into process.env, which the test workers inherit, so vitest.setup.ts and the
// db pool pick it up exactly as they would a CI database.
async function startContainer(): Promise<Client> {
  const name = `nexum-test-pg-${process.pid}`;
  try {
    await run('docker', [
      'run', '-d', '--rm', '--name', name, '--label', 'nexum-test-db=1',
      '-e', `POSTGRES_USER=${TEST_USER}`, '-e', `POSTGRES_PASSWORD=${TEST_PASS}`, '-e', `POSTGRES_DB=${TEST_DB}`,
      '-p', '127.0.0.1::5432', // a free host port, local only
      'postgres:16', '-c', 'fsync=off', '-c', 'full_page_writes=off', // speed; the data is thrown away
    // Long enough for a first-time image pull; short enough that a wedged
    // Docker fails the run instead of hanging it.
    ], { timeout: 180_000 });
  } catch (err) {
    // A timed-out run may still create the container later; don't leave it.
    void run('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
    throw new Error(
      'The database tests need Postgres, and none was reachable, so the test run tried to\n' +
      'start one in Docker and could not. Start Docker Desktop and run the tests again,\n' +
      'or set NEXUM_TEST_DB=skip to run without the database tests.\n\n' +
      // execFile's message is just "Command failed: <the command>"; what
      // Docker actually said is on stderr.
      `docker said: ${((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0]}`,
    );
  }
  container = name;
  const { stdout } = await run('docker', ['port', name, '5432/tcp'], { timeout: 30_000 });
  const port = stdout.trim().split('\n')[0].split(':').pop()!;

  Object.assign(process.env, {
    PG_HOST: '127.0.0.1', PG_PORT: port, PG_USER: TEST_USER, PG_PASSWORD: TEST_PASS,
    PG_DB: TEST_DB, PG_TEST_DB: TEST_DB,
  });

  // Postgres restarts once during first-boot init, so a single successful connect
  // isn't proof; retry until a query answers.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = await tryConnect({
      host: '127.0.0.1', port: Number(port), database: TEST_DB, user: TEST_USER, password: TEST_PASS,
    });
    if (client) {
      try { await client.query('SELECT 1'); return client; } catch { await client.end().catch(() => {}); }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // A failed setup gets no teardown, so clean up here.
  await run('docker', ['stop', '-t', '1', name], { timeout: 30_000 }).catch(() => {});
  container = null;
  throw new Error(`The test Postgres container ${name} did not start within 60s.`);
}

export async function setup(): Promise<void> {
  loadDotenv({ quiet: true });

  // Mirror vitest.setup.ts's redirect: guard the same database the workers use.
  const current = process.env.PG_DB ?? 'eve_nexum';
  const database = process.env.PG_TEST_DB ?? (current.endsWith('_test') ? current : `${current}_test`);

  let client = await tryConnect({
    host:     process.env.PG_HOST ?? 'localhost',
    port:     parseInt(process.env.PG_PORT ?? '5432'),
    database,
    user:     process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  });

  if (!client) {
    // Opted out: the integration suites skip (ensureIntegrationDb returns false).
    if (process.env.NEXUM_TEST_DB === 'skip') return;
    client = await startContainer();
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
  if (holder) {
    // Ending the connection releases the advisory lock; unlock first so the intent
    // is explicit rather than a side effect of disconnecting.
    await holder.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await holder.end().catch(() => {});
    holder = null;
  }
  if (container) {
    // Started with --rm, so stopping it also removes it.
    await run('docker', ['stop', '-t', '1', container], { timeout: 30_000 }).catch(() => {});
    container = null;
  }
}
