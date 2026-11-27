import { createSign } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

// Monthly active users from Google Analytics (GA4 Data API), for the usage
// page (services/usageStats.ts). Only the project's own site sets this up:
//
//   GA4_PROPERTY_ID  the GA4 property's numeric id (Admin > Property details)
//   GA_CREDENTIALS   a Google Cloud service account's JSON key, as is or
//                    base64-encoded, whose email has Viewer on that property
//
// Without both, the page shows the self-hosted numbers only.

const log = createLogger('gaReport');

interface ServiceAccount { client_email: string; private_key: string }

function credentials(): { propertyId: string; account: ServiceAccount } | null {
  const propertyId = (process.env.GA4_PROPERTY_ID ?? '').trim();
  const raw = (process.env.GA_CREDENTIALS ?? '').trim();
  if (!/^\d+$/.test(propertyId) || !raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const account = JSON.parse(text) as Partial<ServiceAccount>;
    if (!account.client_email || !account.private_key) return null;
    return { propertyId, account: account as ServiceAccount };
  } catch {
    log.warn('GA_CREDENTIALS is not a service account JSON key');
    return null;
  }
}

export function gaConfigured(): boolean {
  return credentials() !== null;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

let token: { value: string; expires: number } | null = null;

/** An access token for the Analytics Data API, from the service account. */
async function accessToken(account: ServiceAccount): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(signature)}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  const body = await res.json() as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function runReport(propertyId: string, account: ServiceAccount, body: object): Promise<Array<{ dims: string[]; value: number }>> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken(account)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`runReport failed (${res.status})`);
  const out = await res.json() as { rows?: Array<{ dimensionValues?: { value: string }[]; metricValues: { value: string }[] }> };
  return (out.rows ?? []).map((r) => ({
    dims: (r.dimensionValues ?? []).map((d) => d.value),
    value: Number(r.metricValues[0]?.value ?? 0),
  }));
}

export interface GaUsage {
  /** 'YYYY-MM' -> active users that calendar month. */
  months: Record<string, number>;
  /** Active users in the last 30 days. */
  last30d: number;
}

let cache: { at: number; data: GaUsage } | null = null;
const CACHE_MS = 6 * 60 * 60 * 1000;

/** GA's monthly active users for the last 12 months, cached for 6 hours. Null
 *  when GA isn't set up or can't be reached. */
export async function gaUsage(): Promise<GaUsage | null> {
  const c = credentials();
  if (!c) return null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 11);
    const monthly = await runReport(c.propertyId, c.account, {
      dateRanges: [{ startDate: start.toISOString().slice(0, 10), endDate: 'today' }],
      dimensions: [{ name: 'yearMonth' }],
      metrics: [{ name: 'activeUsers' }],
    });
    const recent = await runReport(c.propertyId, c.account, {
      dateRanges: [{ startDate: '29daysAgo', endDate: 'today' }],
      metrics: [{ name: 'activeUsers' }],
    });
    const months: Record<string, number> = {};
    for (const r of monthly) {
      const ym = r.dims[0] ?? '';
      if (/^\d{6}$/.test(ym)) months[`${ym.slice(0, 4)}-${ym.slice(4)}`] = r.value;
    }
    const data = { months, last30d: recent[0]?.value ?? 0 };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    log.warn(`GA report failed: ${err instanceof Error ? err.message : String(err)}`);
    return cache?.data ?? null;
  }
}
