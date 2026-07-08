// Recent GitHub releases (patch notes), for the "Show patch notes" view. Fetched
// from the public upstream repo and cached server-side so the whole org sharing
// one NAT can't blow GitHub's unauthenticated rate limit. Best-effort; the URL
// is a fixed hard-coded endpoint (no user input, no SSRF).
import { createLogger } from '../utils/logger.js';

const log = createLogger('releases');

const REPO       = 'GQuantrill/eve-nexum';
const LIST_URL   = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const OK_TTL_MS   = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 15 * 60 * 1000;
const MAX_BODY    = 20_000; // release notes are small; cap defensively

export interface ReleaseNote {
  version:     string;
  name:        string;
  body:        string;
  url:         string;
  publishedAt: string | null;
}

let cache: { until: number; data: ReleaseNote[] } | null = null;

async function fetchReleases(): Promise<ReleaseNote[] | null> {
  try {
    const r = await fetch(LIST_URL, {
      headers:  { Accept: 'application/vnd.github+json', 'User-Agent': 'nexum-patchnotes' },
      signal:   AbortSignal.timeout(6000),
      redirect: 'error',
    });
    if (!r.ok) { log.warn(`GitHub releases API returned ${r.status}`); return null; }
    const arr = await r.json() as Array<{
      tag_name?: string; name?: string; body?: string; html_url?: string;
      published_at?: string; draft?: boolean;
    }>;
    if (!Array.isArray(arr)) return null;
    return arr
      .filter((x) => !x.draft)
      .slice(0, 10)
      .map((x) => ({
        version:     (x.tag_name ?? '').replace(/^v/i, ''),
        name:        x.name ?? x.tag_name ?? '',
        body:        (x.body ?? '').slice(0, MAX_BODY),
        url:         x.html_url ?? '',
        publishedAt: x.published_at ?? null,
      }));
  } catch (e) {
    log.warn(`releases fetch failed: ${(e as Error).message}`);
    return null;
  }
}

export async function getRecentReleases(): Promise<ReleaseNote[]> {
  if (cache && Date.now() < cache.until) return cache.data;
  const data = await fetchReleases();
  if (data) {
    cache = { until: Date.now() + OK_TTL_MS, data };
    return data;
  }
  // Failure: serve a stale cache if we have one (short retry), else empty.
  if (cache) { cache.until = Date.now() + FAIL_TTL_MS; return cache.data; }
  cache = { until: Date.now() + FAIL_TTL_MS, data: [] };
  return [];
}
