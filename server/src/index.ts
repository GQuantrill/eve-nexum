import 'dotenv/config';
import './config.js'; // validates env vars at startup
import express from 'express';
import cors from 'cors';
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
import scoutRouter        from './routes/scout.js';
import routeRouter        from './routes/route.js';
import wormholesRouter    from './routes/wormholes.js';
import { loadRouteGraph } from './services/routeGraph.js';
import { adminRouter }   from './routes/admin.js';
import { standingsRouter } from './routes/standings.js';
import { knownStructuresRouter } from './routes/knownStructures.js';
import { initCorpStructuresPoller } from './services/corpStructures.js';
import { initPublicStructuresPoller } from './services/publicStructures.js';
import { authLimiter, esiLimiter, publicLimiter } from './middleware/rateLimits.js';

const PgStore = connectPgSimple(session);
const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5174',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

app.use(session({
  store: new PgStore({ pool: db, tableName: 'sessions', createTableIfMissing: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use('/auth', authLimiter, authRouter);
app.use('/api/systems', publicLimiter, systemsRouter);
app.use('/api/maps', mapsRouter);
app.use('/api/character', esiLimiter, characterRouter);
app.use('/api/killboard', esiLimiter, killboardRouter);
app.use('/api/activity',  esiLimiter, activityRouter);
app.use('/api/stats',      statsRouter);
app.use('/api/incursions',  esiLimiter, incursionsRouter);
app.use('/api/insurgency',  esiLimiter, insurgencyRouter);
app.use('/api/scout',       esiLimiter, scoutRouter);
app.use('/api/route',       esiLimiter, routeRouter);
app.use('/api/wormholes',   esiLimiter, wormholesRouter);
app.use('/api/admin',             adminRouter);
app.use('/api/standings',         standingsRouter);
app.use('/api/known-structures',  knownStructuresRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

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
