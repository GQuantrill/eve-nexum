import { Router } from 'express';
import * as cheerio from 'cheerio';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue } from '../utils/cache.js';

// Scrapes the EveScout Rescue stormtrack page — the only public-facing
// source for null-sec storm locations right now (ESI doesn't expose
// them). Mirrors the incursions pipeline: in-memory TtlValue, one shared
// fetch on cache miss, fall back to stale on upstream errors.

const router = Router();
router.use(requireAuth);
const log = createLogger('storms');

const SOURCE_URL    = 'https://evescoutrescue.com/home/stormtrack.php';
const CACHE_TTL_MS  = 30 * 60 * 1000;
const FETCH_TIMEOUT = 15_000;

export type StormType = 'electric' | 'gamma' | 'exotic' | 'plasma' | 'unknown';

export interface StormSystem {
  eveSystemId:    number | null; // null when resolution failed (rare)
  systemName:     string;
  regionName:     string;
  stormName:      string;        // e.g. "Plasma A"
  stormType:      StormType;
  lastReport:     string;        // raw "May-18@19:19" — display as-is
  hoursInSystem:  number | null; // numeric where parseable
  reportedBy:     string;
}

const cache = new TtlValue<StormSystem[]>(CACHE_TTL_MS);

function classifyStorm(label: string): StormType {
  const l = label.toLowerCase();
  if (l.includes('electric')) return 'electric';
  if (l.includes('gamma'))    return 'gamma';
  if (l.includes('exotic'))   return 'exotic';
  if (l.includes('plasma'))   return 'plasma';
  return 'unknown';
}

// Resolve a batch of system names to eve_system_id in a single query.
// Returns a name→id map; names that didn't match aren't keyed.
async function resolveSystemIds(names: string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM solar_systems WHERE name = ANY($1::text[])`,
    [names],
  );
  return new Map(rows.map((r) => [r.name, r.id]));
}

async function fetchAndParse(): Promise<StormSystem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  let html: string;
  try {
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal, headers: { 'User-Agent': 'pathfinder-storm-scraper' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);

  // The page renders storms as table rows. Header row tells us which column
  // is which — don't hard-code positions, the site has reshuffled columns
  // before. Match by label (case-insensitive).
  const table = $('table').filter((_, t) => {
    const headers = $(t).find('th').map((_, th) => $(th).text().trim().toLowerCase()).get();
    return headers.includes('region') && headers.includes('system');
  }).first();
  if (table.length === 0) {
    throw new Error('storm table not found on page');
  }

  const headers = table.find('th').map((_, th) => $(th).text().trim().toLowerCase()).get();
  const colIdx = (label: string) => headers.findIndex((h) => h === label);
  const idx = {
    region:   colIdx('region'),
    system:   colIdx('system'),
    name:     colIdx('name'),
    type:     colIdx('type'),
    report:   colIdx('last report'),
    hours:    colIdx('hours in system'),
    reporter: colIdx('reported by'),
  };

  const raw: Array<Omit<StormSystem, 'eveSystemId'>> = [];
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length === 0) return;
    const region   = idx.region   >= 0 ? cells[idx.region]   ?? '' : '';
    const system   = idx.system   >= 0 ? cells[idx.system]   ?? '' : '';
    const name     = idx.name     >= 0 ? cells[idx.name]     ?? '' : '';
    const type     = idx.type     >= 0 ? cells[idx.type]     ?? '' : '';
    const report   = idx.report   >= 0 ? cells[idx.report]   ?? '' : '';
    const hoursStr = idx.hours    >= 0 ? cells[idx.hours]    ?? '' : '';
    const reporter = idx.reporter >= 0 ? cells[idx.reporter] ?? '' : '';
    if (!system) return;
    const hours = parseFloat(hoursStr);
    raw.push({
      systemName:    system,
      regionName:    region,
      stormName:     name,
      stormType:     classifyStorm(`${type} ${name}`),
      lastReport:    report,
      hoursInSystem: Number.isFinite(hours) ? hours : null,
      reportedBy:    reporter,
    });
  });

  const idMap = await resolveSystemIds(raw.map((r) => r.systemName));
  return raw.map((r) => ({ ...r, eveSystemId: idMap.get(r.systemName) ?? null }));
}

router.get('/', async (_req, res) => {
  const fresh = cache.get();
  if (fresh) { res.json(fresh); return; }
  try {
    const data = await fetchAndParse();
    cache.set(data);
    res.json(data);
  } catch (err) {
    log.error('storm scrape failed:', err);
    const stale = cache.getStale();
    if (stale) { res.json(stale); return; }
    res.status(502).json({ error: 'Failed to fetch storms' });
  }
});

export default router;
