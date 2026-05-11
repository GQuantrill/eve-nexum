import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { db } from './db.js';
import { migrate } from './migrate.js';
import { systemsRouter } from './routes/systems.js';
import { authRouter } from './routes/auth.js';
import { mapsRouter } from './routes/maps.js';
import { characterRouter } from './routes/character.js';
import killboardRouter from './routes/killboard.js';
import activityRouter  from './routes/activity.js';

const PgStore = connectPgSimple(session);
const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5174',
  credentials: true,
}));
app.use(express.json());

app.use(session({
  store: new PgStore({ pool: db, tableName: 'sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use('/auth', authRouter);
app.use('/api/systems', systemsRouter);
app.use('/api/maps', mapsRouter);
app.use('/api/character', characterRouter);
app.use('/api/killboard', killboardRouter);
app.use('/api/activity', activityRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

migrate()
  .then(() => app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`)))
  .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
