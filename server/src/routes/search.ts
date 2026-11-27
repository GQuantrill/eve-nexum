import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlCache } from '../utils/cache.js';
import { db } from '../db.js';

const log = createLogger('search');

export const searchRouter = Router();
searchRouter.use(requireAuth);

const ESI_TIMEOUT_MS = 8_000;

// Cache exact-name lookups for 24h. Character / corp names are effectively
// immutable; this stops a debounced search-as-you-type UI from hammering ESI.
// Swept hourly: the batch check below can add a few dozen names per call.
const lookupCache = new TtlCache<string, { id: number; name: string } | null>(24 * 60 * 60 * 1000, 60 * 60 * 1000);

interface IdsResponse {
  characters?:    Array<{ id: number; name: string }>;
  corporations?:  Array<{ id: number; name: string }>;
  alliances?:     Array<{ id: number; name: string }>;
  // …other categories exist; we only consume the two we need
}

// ESI POST /universe/ids/ accepts an array of exact names and returns them
// categorised. Single-name calls are fine — small payload, no batch needed
// for an interactive picker.
async function lookupExactName(name: string): Promise<IdsResponse | null> {
  try {
    const res = await esiFetch('https://esi.evetech.net/latest/universe/ids/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify([name]),
      signal:  AbortSignal.timeout(ESI_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 just means the name doesn't exist — not an error
      if (res.status !== 404) log.warn(`ESI /universe/ids/ returned ${res.status} for "${name}"`);
      return null;
    }
    return await res.json() as IdsResponse;
  } catch (err) {
    log.warn(`ESI /universe/ids/ failed for "${name}":`, err);
    return null;
  }
}

// Validate + normalise the query string before sending to ESI. EVE names are
// 3–37 chars and use a restricted alphabet; rejecting bad input here avoids
// pointless ESI hits.
function cleanQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return null;
  // EVE allows letters, digits, space, apostrophe, hyphen, period. We're
  // permissive — ESI itself rejects anything genuinely invalid.
  if (!/^[\w\s'.\-]+$/u.test(trimmed)) return null;
  return trimmed;
}

// GET /api/search/characters?q=<exact name>
// Returns { id, name } on exact match, or { match: null } when no character
// by that name exists. Local users table is checked first so a recipient
// who has logged into Nexum resolves without an ESI round-trip.
searchRouter.get('/characters', async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q) { res.json({ match: null }); return; }
  const key = `char:${q.toLowerCase()}`;

  // 1) Local users table — case-insensitive equality so users can be lazy
  //    about capitalisation. character_name is the in-game spelling.
  const { rows: localRows } = await db.query<{ id: number; name: string }>(
    `SELECT character_id AS id, character_name AS name
       FROM users
      WHERE LOWER(character_name) = LOWER($1)
      LIMIT 1`,
    [q],
  );
  if (localRows.length > 0) {
    res.json({ match: { id: localRows[0].id, name: localRows[0].name } });
    return;
  }

  // 2) Cache (avoids re-asking ESI for the same negative result)
  const cached = lookupCache.get(key);
  if (cached !== null) {
    res.json({ match: cached.value });
    return;
  }

  // 3) ESI exact-name lookup
  const body = await lookupExactName(q);
  const match = body?.characters?.[0]
    ? { id: body.characters[0].id, name: body.characters[0].name }
    : null;
  lookupCache.set(key, match);
  res.json({ match });
});

// POST /api/search/characters/batch { names: string[] }
// Which of these exact names are pilots: the words of intel lines that could
// be names, so the watch list only suggests real ones. One ESI call for the
// names not already cached (a miss is cached too), at most MAX_BATCH names.
const MAX_BATCH = 30;
searchRouter.post('/characters/batch', async (req, res) => {
  const raw = (req.body as { names?: unknown } | undefined)?.names;
  if (!Array.isArray(raw) || raw.length > MAX_BATCH) { res.status(400).json({ error: 'invalid_names' }); return; }
  const names = [...new Set(raw.map(cleanQuery).filter((n): n is string => !!n && n.length <= 37))];
  const found: Array<{ id: number; name: string }> = [];
  const ask: string[] = [];
  for (const n of names) {
    const hit = lookupCache.get(`char:${n.toLowerCase()}`);
    if (hit === null) ask.push(n);
    else if (hit.value) found.push(hit.value);
  }
  if (ask.length > 0) {
    let body: IdsResponse | null = null;
    try {
      const r = await esiFetch('https://esi.evetech.net/latest/universe/ids/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(ask),
        signal:  AbortSignal.timeout(ESI_TIMEOUT_MS),
      });
      // 404: none of them exist.
      body = r.ok ? await r.json() as IdsResponse : r.status === 404 ? {} : null;
      if (!body) log.warn(`ESI /universe/ids/ returned ${r.status} for a batch of ${ask.length}`);
    } catch (err) {
      log.warn('ESI /universe/ids/ batch failed:', err);
    }
    if (body) {
      const byName = new Map((body.characters ?? []).map((c) => [c.name.toLowerCase(), { id: c.id, name: c.name }]));
      for (const n of ask) {
        const m = byName.get(n.toLowerCase()) ?? null;
        lookupCache.set(`char:${n.toLowerCase()}`, m);
        if (m) found.push(m);
      }
    }
  }
  res.json(found);
});

// GET /api/search/corporations?q=<exact name>
// Same shape as /characters. ESI exact-match is the only practical
// option here — local cache (entity_names) doesn't index by name.
searchRouter.get('/corporations', async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q) { res.json({ match: null }); return; }
  const key = `corp:${q.toLowerCase()}`;

  const cached = lookupCache.get(key);
  if (cached !== null) {
    res.json({ match: cached.value });
    return;
  }

  const body = await lookupExactName(q);
  const match = body?.corporations?.[0]
    ? { id: body.corporations[0].id, name: body.corporations[0].name }
    : null;
  lookupCache.set(key, match);
  res.json({ match });
});

// GET /api/search/alliances?q=<exact name>
// Same shape as /corporations. Used by the admin access allow-list picker to
// resolve an alliance name to its id (alliance grants are alliance-install-only).
searchRouter.get('/alliances', async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q) { res.json({ match: null }); return; }
  const key = `alliance:${q.toLowerCase()}`;

  const cached = lookupCache.get(key);
  if (cached !== null) {
    res.json({ match: cached.value });
    return;
  }

  const body = await lookupExactName(q);
  const match = body?.alliances?.[0]
    ? { id: body.alliances[0].id, name: body.alliances[0].name }
    : null;
  lookupCache.set(key, match);
  res.json({ match });
});

export default searchRouter;
