import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { shortestRoutes, nearestRoutes, type RouteMode, type RouteOverlay } from '../services/routeGraph.js';
import { isServerKind, serverKindTargets } from '../services/nearestSets.js';
import { buildRouteOverlay } from '../services/routeOverlay.js';
import { expiredScoutIds } from './scout.js';
import { getMapAccess, visibleMapIds } from './maps.js';

const router = Router();
router.use(requireAuth);
const log = createLogger('route');

// BFS/Dijkstra are O(V+E) regardless of target count — extra targets
// just add early-termination checks. The cap exists purely to bound
// URL length (each ID is 8-9 chars) and prevent abuse. Proximity-alerts
// fans out across every hostile-sov system, which can run into the
// hundreds for users with wide negative-standing contact lists.
const MAX_TARGETS = 2000;
const VALID_MODES = new Set<RouteMode>(['shortest', 'secure']);
// The avoidance list rides on every route request, so keep it bounded.
const MAX_AVOID = 200;

// GET /api/route?from=<systemId>&to=<id1>,<id2>,...&mode=shortest|secure[&avoid=<id>,...]
// Returns { [targetId]: { jumps, path } } for each reachable target.
router.get('/', async (req, res) => {
  const from = Number(req.query.from);
  if (!Number.isInteger(from) || from <= 0) {
    return res.status(400).json({ error: 'Invalid "from"' });
  }

  const toRaw = String(req.query.to ?? '').trim();
  if (!toRaw) return res.json({});

  const targets = toRaw.split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0);

  if (targets.length === 0) return res.json({});
  if (targets.length > MAX_TARGETS) {
    return res.status(400).json({ error: `Too many targets (max ${MAX_TARGETS})` });
  }

  const opts = await readRouteOptions(req, req.query as Record<string, unknown>);
  if ('error' in opts) return res.status(opts.status).json({ error: opts.error });

  try {
    const result = await shortestRoutes(from, targets, opts.mode, await opts.overlay(), opts.avoid);
    return res.json(result);
  } catch (err) {
    log.error('Route compute failed:', err);
    return res.status(500).json({ error: 'Route computation failed' });
  }
});

/** How a route is asked for, the same for one route or the nearest few: the
 *  mode, the avoidance list and which shortcuts (Thera, Turnur, mapped chains,
 *  Ansiblex) may be used. Read from the query string or a JSON body. */
type RouteOptions = {
  mode: RouteMode;
  avoid?: Set<number>;
  overlay: () => Promise<RouteOverlay | undefined>;
};
async function readRouteOptions(
  req: Request, src: Record<string, unknown>,
): Promise<RouteOptions | { error: string; status: number }> {
  const ids = (v: unknown): number[] => (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const flag = (v: unknown) => String(v) === 'true';

  const avoidIds = ids(src.avoid);
  if (avoidIds.length > MAX_AVOID) return { error: `Too many avoided systems (max ${MAX_AVOID})`, status: 400 };
  const avoid = avoidIds.length ? new Set(avoidIds) : undefined;

  const modeRaw = String(src.mode ?? 'shortest') as RouteMode;
  const mode: RouteMode = VALID_MODES.has(modeRaw) ? modeRaw : 'shortest';

  // Optional shortcut edges spliced into the graph (opt-in per request).
  const includeThera     = flag(src.includeThera);
  const includeTurnur    = flag(src.includeTurnur);
  const includeWormholes = flag(src.includeWormholes);
  const includeAnsiblex  = flag(src.includeAnsiblex);
  const skipEol          = flag(src.avoidEol);
  const mapId = typeof src.mapId === 'string' ? src.mapId : undefined;
  // whScope=all unions the wormhole/Ansiblex chains of EVERY map the caller can
  // see (the Closest Systems pane is a per-user tool, so the chain they're
  // actually sitting in should route regardless of the active tab). Otherwise a
  // single explicit mapId is used, as before.
  const allScope = src.whScope === 'all';

  // Wormhole / Ansiblex edges come from mapped chains. Resolve which maps to
  // pull from and enforce access. Fail loudly rather than silently returning a
  // gates-only route, which would mislead the user into thinking no shortcut
  // route exists.
  let mapIds: string[] = [];
  if (includeWormholes || includeAnsiblex) {
    if (allScope) {
      // visibleMapIds is already access-scoped (personal + corp + alliance +
      // shared), so no per-map getMapAccess is needed.
      mapIds = await visibleMapIds(req);
    } else {
      if (!mapId) return { error: 'mapId required for map-based shortcuts', status: 400 };
      const access = await getMapAccess(mapId, req);
      if (!access) return { error: 'Map not found', status: 404 };
      mapIds = [mapId];
    }
  }

  return {
    mode,
    avoid,
    overlay: async () => {
      // Only worth the lookup when a scout hub is actually in play.
      const expiredScout = (includeThera || includeTurnur) ? await expiredScoutIds(req) : undefined;
      return (includeThera || includeTurnur || includeWormholes || includeAnsiblex)
        ? buildRouteOverlay({ thera: includeThera, turnur: includeTurnur, wormholes: includeWormholes, ansiblex: includeAnsiblex, mapIds, expiredScout, skipEol })
        : undefined;
    },
  };
}

// POST /api/route/nearest -- the Closest Systems suggestions. Body: the route
// options as for GET /, plus `from`, `limit` (1-5) and `sets`: a name for each
// list wanted, mapped to a server-known kind ('lowsec', 'blueloot',
// 'service:cloning'...), to { kind, exclude } (the quiet-system list: every
// k-space system but the ones with kills), or to the client's own candidate
// ids (A0s, clones...). Answers { [set]: [{ id, jumps, path, usesSpecial, detail? }] }.
const MAX_SETS = 24;
const MAX_CLIENT_IDS = 5000;
router.post('/nearest', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const from = Number(body.from);
  if (!Number.isInteger(from) || from <= 0) return res.status(400).json({ error: 'Invalid "from"' });
  const limit = Math.min(5, Math.max(1, Number(body.limit) || 3));
  const sets = body.sets && typeof body.sets === 'object' && !Array.isArray(body.sets)
    ? Object.entries(body.sets as Record<string, unknown>) : [];
  if (sets.length === 0 || sets.length > MAX_SETS) return res.status(400).json({ error: 'Invalid "sets"' });
  const cleanIds = (v: unknown): number[] | null => {
    if (!Array.isArray(v) || v.length > MAX_CLIENT_IDS) return null;
    return v.filter((n): n is number => Number.isInteger(n) && n > 0);
  };

  const opts = await readRouteOptions(req, body);
  if ('error' in opts) return res.status(opts.status).json({ error: opts.error });

  try {
    const overlay = await opts.overlay();
    const out: Record<string, unknown[]> = {};
    for (const [name, spec] of sets) {
      if (!/^[a-z0-9:-]{1,40}$/i.test(name)) continue;
      let ids: Iterable<number>;
      let detail: Map<number, number[]> | undefined;
      let exclude: Set<number> | undefined;
      const kind = typeof spec === 'string' ? spec
        : spec && typeof spec === 'object' && !Array.isArray(spec) ? (spec as { kind?: unknown }).kind : undefined;
      if (typeof kind === 'string' && isServerKind(kind)) {
        const t = await serverKindTargets(kind);
        ids = t.ids; detail = t.detail;
        if (typeof spec === 'object') {
          const ex = cleanIds((spec as { exclude?: unknown }).exclude ?? []);
          if (!ex) continue;
          exclude = new Set(ex);
        }
      } else {
        const list = cleanIds(spec);
        if (!list) continue;
        ids = list;
      }
      const wanted = exclude?.size ? [...ids].filter((id) => !exclude.has(id)) : ids;
      const found = await nearestRoutes(from, wanted, limit, opts.mode, overlay, opts.avoid);
      out[name] = found.map((r) => (detail?.has(r.id) ? { ...r, detail: detail.get(r.id) } : r));
    }
    return res.json(out);
  } catch (err) {
    log.error('Nearest compute failed:', err);
    return res.status(500).json({ error: 'Route computation failed' });
  }
});

export default router;
