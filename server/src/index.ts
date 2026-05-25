import 'dotenv/config';
import './config.js'; // validates env vars at startup
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { db } from './db.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { systemsRouter } from './routes/systems.js';
import { authRouter } from './routes/auth.js';
import { mapsRouter } from './routes/maps.js';
import { characterRouter } from './routes/character.js';
import killboardRouter from './routes/killboard.js';
import activityRouter, { initActivity } from './routes/activity.js';
import statsRouter      from './routes/stats.js';
import incursionsRouter  from './routes/incursions.js';
import insurgencyRouter  from './routes/insurgency.js';
import stormsRouter       from './routes/storms.js';
import scoutRouter        from './routes/scout.js';
import routeRouter        from './routes/route.js';
import wormholesRouter    from './routes/wormholes.js';
import { loadRouteGraph } from './services/routeGraph.js';
import { adminRouter, adminReadRouter, reportsRouter } from './routes/admin.js';
import { standingsRouter } from './routes/standings.js';
import { knownStructuresRouter } from './routes/knownStructures.js';
import { shareRouter } from './routes/share.js';
import searchRouter from './routes/search.js';
import { initCorpStructuresPoller } from './services/corpStructures.js';
import { initPublicStructuresPoller } from './services/publicStructures.js';
import { authLimiter, esiLimiter, publicLimiter, appLimiter } from './middleware/rateLimits.js';
import { originGuard } from './middleware/originGuard.js';
import { createLogger } from './utils/logger.js';

const rootLog = createLogger('http');

const PgStore = connectPgSimple(session);
const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Default Helmet is safe for a JSON API: HSTS (HTTPS only), nosniff,
// frameguard=deny, referrer-policy=no-referrer, etc. CSP is disabled
// because we serve JSON not HTML — the frontend is delivered by nginx,
// which is where any meaningful CSP belongs.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5174',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Derive cookie.secure from FRONTEND_URL's protocol rather than NODE_ENV.
// Tying it to NODE_ENV breaks the common "production build running over plain
// HTTP on localhost or a LAN box" case — the browser silently drops Secure
// cookies served over HTTP and OAuth state checks fail with a 400.
const frontendIsHttps = (process.env.FRONTEND_URL ?? '').startsWith('https://');

app.use(session({
  store: new PgStore({ pool: db, tableName: 'sessions', createTableIfMissing: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: frontendIsHttps,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Defense-in-depth CSRF gate on state-changing methods. Sits after the
// session middleware (so logout etc. still see the session) but before
// any route is reached. SameSite=lax is the primary protection; this
// catches the residual cases.
app.use(originGuard(process.env.FRONTEND_URL ?? 'http://localhost:5174'));

app.use('/auth', authLimiter, authRouter);
app.use('/api/systems', publicLimiter, systemsRouter);
app.use('/api/maps', appLimiter, mapsRouter);
// Public read-only share endpoint — no auth, validates the share_token
// itself. Rate-limited under publicLimiter alongside other unauthed routes.
app.use('/api/share', publicLimiter, shareRouter);
app.use('/api/character', esiLimiter, characterRouter);
app.use('/api/killboard', esiLimiter, killboardRouter);
app.use('/api/activity',  esiLimiter, activityRouter);
app.use('/api/stats',      appLimiter, statsRouter);
app.use('/api/incursions',  esiLimiter, incursionsRouter);
app.use('/api/insurgency',  esiLimiter, insurgencyRouter);
app.use('/api/storms',      esiLimiter, stormsRouter);
app.use('/api/scout',       esiLimiter, scoutRouter);
app.use('/api/route',       esiLimiter, routeRouter);
app.use('/api/wormholes',   esiLimiter, wormholesRouter);
app.use('/api/admin/reports',     appLimiter, reportsRouter);
app.use('/api/admin',             appLimiter, adminReadRouter);
app.use('/api/admin',             appLimiter, adminRouter);
app.use('/api/standings',         appLimiter, standingsRouter);
app.use('/api/known-structures',  appLimiter, knownStructuresRouter);
app.use('/api/search',            esiLimiter, searchRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Catch-all error middleware. Logs the failure with method+path for triage
// and returns a generic 500 — stack traces stay in the server logs rather
// than leaking through to a stray client. The 4-arg signature is what
// makes Express recognise this as an error handler vs a normal middleware.
//
// SyntaxError from express.json() (malformed body) shows up here too; we
// surface that as a clean 400 so the client knows it sent garbage.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  rootLog.error(`${req.method} ${req.originalUrl} →`, err);
  if (res.headersSent) return;
  res.status(err.status ?? 500).json({ error: 'internal' });
});

async function expireMaps() {
  if (!config.corpMode) return;
  const cutoff = new Date(Date.now() - config.corpMapExpireDays * 24 * 60 * 60 * 1000);
  const { rowCount } = await db.query(
    `DELETE FROM maps WHERE last_active_at < $1`,
    [cutoff],
  );
  if (rowCount) console.log(`Expired ${rowCount} inactive map(s)`);
}

migrate()
  .then(async () => {
    await expireMaps();
    setInterval(expireMaps, 60 * 60 * 1000); // re-check hourly
    await initActivity();
    await loadRouteGraph();
    initCorpStructuresPoller();
    initPublicStructuresPoller();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
