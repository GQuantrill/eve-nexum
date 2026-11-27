import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { gaUsage, gaConfigured } from './gaReport.js';
import { getInstanceId, collectUsageStats } from './telemetry.js';

// The usage page: monthly active users on this site (Google Analytics, and
// signed-in pilots) beside the self-hosted installs' own counts (their daily
// telemetry pings), for the admin Reports tab and a shareable link.
//
// A self-hosted install's month is its last ping that month: its "active in
// the last 30 days" count then. Installs are summed. A pilot who uses two
// installs counts twice; the counts can't tell.

export interface UsageMonth {
  month: string;                 // 'YYYY-MM'
  liveGa: number | null;         // GA active users (null: GA not set up)
  liveSignedIn: number | null;   // pilots signed in to this site
  selfHosted: number;            // summed across self-hosted installs
  selfHostedInstances: number;   // installs that pinged that month
}

export interface UsageReport {
  generatedAt: string;
  gaConnected: boolean;
  current: {
    liveGa30d: number | null;
    liveSignedIn30d: number | null;
    selfHosted30d: number;
    selfHostedAccounts30d: number;
    selfHostedInstances: number;
    /** Installs on a version too old to send usage counts. */
    instancesWithoutCounts: number;
    desktop30d: number;
    total30d: number;
  };
  months: UsageMonth[];
  breakdown: {
    modes: Record<string, number>;
    versions: Record<string, number>;
    languages: Record<string, number>;
    features: Record<string, number>;
  };
}

interface DayRow { instanceId: string; month: string; version: string | null; stats: Record<string, unknown> }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const add = (into: Record<string, number>, key: string, n: number) => { into[key] = (into[key] ?? 0) + n; };

function lastMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

export async function buildUsageReport(): Promise<UsageReport> {
  const self = await getInstanceId();
  const months = lastMonths(12);

  // Each install's last ping in each month.
  const { rows: monthRows } = await db.query<DayRow>(
    `SELECT DISTINCT ON (to_char(day, 'YYYY-MM'), instance_id)
            instance_id AS "instanceId", to_char(day, 'YYYY-MM') AS month, version, stats
       FROM telemetry_daily
      WHERE day >= $1::date
      ORDER BY to_char(day, 'YYYY-MM'), instance_id, day DESC`,
    [`${months[0]}-01`]);
  // Each install's latest ping, if it pinged in the last 3 days (pings are daily).
  const { rows: latest } = await db.query<DayRow>(
    `SELECT DISTINCT ON (instance_id)
            instance_id AS "instanceId", to_char(day, 'YYYY-MM') AS month, version, stats
       FROM telemetry_daily
      WHERE day >= CURRENT_DATE - 2
      ORDER BY instance_id, day DESC`);

  const ga = await gaUsage();
  const byMonth = new Map(months.map((m) => [m, {
    month: m, liveGa: ga ? ga.months[m] ?? 0 : null, liveSignedIn: null as number | null,
    selfHosted: 0, selfHostedInstances: 0,
  }]));
  for (const r of monthRows) {
    const m = byMonth.get(r.month);
    if (!m) continue;
    if (r.instanceId === self) { m.liveSignedIn = r.stats.active30d == null ? null : num(r.stats.active30d); continue; }
    m.selfHostedInstances++;
    m.selfHosted += num(r.stats.active30d);
  }

  const breakdown = { modes: {}, versions: {}, languages: {}, features: {} } as UsageReport['breakdown'];
  let selfHosted30d = 0, selfHostedAccounts30d = 0, selfHostedInstances = 0, withoutCounts = 0, desktop30d = 0;
  for (const r of latest) {
    const s = r.stats;
    if (r.version) add(breakdown.versions, r.version, 1);
    if (typeof s.mode === 'string') add(breakdown.modes, s.mode, 1);
    for (const [k, n] of Object.entries((s.languages ?? {}) as Record<string, unknown>)) add(breakdown.languages, k, num(n));
    for (const [k, n] of Object.entries((s.features ?? {}) as Record<string, unknown>)) add(breakdown.features, k, num(n));
    desktop30d += num(s.desktop30d);
    if (r.instanceId === self) continue;
    selfHostedInstances++;
    if (s.active30d == null) { withoutCounts++; continue; }
    selfHosted30d += num(s.active30d);
    selfHostedAccounts30d += num(s.accounts30d);
  }

  // This site's own counts, read now rather than from its last ping.
  const own = await collectUsageStats();
  const thisMonth = byMonth.get(months[months.length - 1]);
  if (own && thisMonth) thisMonth.liveSignedIn = own.active30d;

  const live30d = ga?.last30d ?? own?.active30d ?? 0;
  return {
    generatedAt: new Date().toISOString(),
    gaConnected: gaConfigured(),
    current: {
      liveGa30d: ga?.last30d ?? null,
      liveSignedIn30d: own?.active30d ?? null,
      selfHosted30d, selfHostedAccounts30d, selfHostedInstances,
      instancesWithoutCounts: withoutCounts,
      desktop30d,
      total30d: live30d + selfHosted30d,
    },
    months: [...byMonth.values()],
    breakdown,
  };
}

// ── The shareable link ─────────────────────────────────────────────────────
// One link at a time; only its hash is stored, so the link itself is shown
// once, when made. Making a new one retires the old.

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUsageShare(): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO usage_share (id, token_hash, created_at) VALUES (TRUE, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = NOW()`, [hash(token)]);
  return token;
}

export async function deleteUsageShare(): Promise<void> {
  await db.query(`DELETE FROM usage_share`);
}

export async function usageShareStatus(): Promise<{ active: boolean; createdAt: string | null }> {
  const { rows: [r] } = await db.query<{ createdAt: Date }>(`SELECT created_at AS "createdAt" FROM usage_share`);
  return { active: !!r, createdAt: r ? r.createdAt.toISOString() : null };
}

export async function usageShareValid(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false;
  const { rowCount } = await db.query(`SELECT 1 FROM usage_share WHERE token_hash = $1`, [hash(token)]);
  return !!rowCount;
}
