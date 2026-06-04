import { Pool } from 'pg';

export const db = new Pool({
  host:     process.env.PG_HOST     ?? 'localhost',
  port:     parseInt(process.env.PG_PORT ?? '5432'),
  database: process.env.PG_DB       ?? 'eve_sde',
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  // Bounded pool + timeouts. This same pool also backs the session store, so
  // without a connection timeout a slow/exhausted pool would make requests
  // hang on connect() rather than fail fast; statement_timeout caps any single
  // runaway query so it can't pin a connection indefinitely.
  max:                     parseInt(process.env.PG_POOL_MAX ?? '20', 10),
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout:       15_000,
});
