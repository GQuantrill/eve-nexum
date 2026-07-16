// Runs (via setupFiles) in every test worker before the test modules load.
//
// Loads the local .env for DB credentials, relaxes config.ts's production guards,
// and — critically — redirects the DB pool to a DEDICATED throwaway `*_test`
// database. The integration suites TRUNCATE tables between tests, so this guard
// makes it impossible to point them at a real database by accident: if the
// resolved name doesn't end in `_test`, we refuse to start.
import { config as loadDotenv } from 'dotenv';

loadDotenv();

// Relax the prod-only guards in config.ts (SESSION_SECRET etc.) for tests.
process.env.NODE_ENV = 'development';

const current = process.env.PG_DB ?? 'eve_nexum';
const testDb = process.env.PG_TEST_DB ?? (current.endsWith('_test') ? current : `${current}_test`);
if (!testDb.endsWith('_test')) {
  throw new Error(`Refusing to run tests against non-test database "${testDb}" — the test DB name must end in _test`);
}
process.env.PG_DB = testDb;
