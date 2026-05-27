import { createHash } from 'node:crypto';

// CORP_ID accepts a comma-separated list of corporation IDs. Any member of
// any listed corp is allowed to log in.
const CORP_IDS: number[] = (process.env.CORP_ID ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isInteger(n) && n > 0);

const ADMIN_CHAR_ID = process.env.ADMIN_CHAR_ID ? parseInt(process.env.ADMIN_CHAR_ID, 10) : null;
const REPORTS_CHAR_ID = process.env.RV_REPORT_ID ? parseInt(process.env.RV_REPORT_ID, 10) : null;
const CORP_MAP_TIME = parseInt(process.env.CORP_MAP_TIME ?? '30', 10);

// When true, every member of any listed corp can see every corp map regardless
// of which corp created it. When false (default), corp maps are visible only
// to members of the corp that created them — Corp A's chain is invisible to
// Corp B even if they share the deployment.
const CORP_MAP_SHARED = /^(1|true|yes)$/i.test(process.env.CORP_MAP_SHARED ?? '');

// DISCORD_WEBHOOK_URL — optional corp-intel notifications (inbound K162, new
// connections). Two accepted forms:
//   • a single webhook URL                → used for every corp map
//   • "corpId=URL,corpId=URL" pairs        → per-corp routing (multi-corp deploys)
// '=' splits the id from the URL because URLs contain ':'; entries are
// comma-separated (Discord webhook URLs contain no commas). A bare http(s)
// entry sets the default. Unset → the feature is simply off.
function parseDiscordWebhooks(raw: string | undefined): { defaultUrl: string | null; byCorp: Record<number, string> } {
  const byCorp: Record<number, string> = {};
  let defaultUrl: string | null = null;
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(entry)) {
      defaultUrl = entry;
      continue;
    }
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const id = parseInt(entry.slice(0, eq).trim(), 10);
    const url = entry.slice(eq + 1).trim();
    if (Number.isInteger(id) && id > 0 && /^https?:\/\//i.test(url)) byCorp[id] = url;
  }
  return { defaultUrl, byCorp };
}
const DISCORD_WEBHOOKS = parseDiscordWebhooks(process.env.DISCORD_WEBHOOK_URL);

if (CORP_IDS.length > 0 && ADMIN_CHAR_ID === null) {
  console.error('FATAL: CORP_ID is set but ADMIN_CHAR_ID is missing');
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';

// Session secret must be explicitly set in production — a guessable default
// is a critical session-forgery risk.
if (isProd && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production');
  process.exit(1);
}

if (isProd && !process.env.EVE_CLIENT_ID) {
  console.error('FATAL: EVE_CLIENT_ID must be set in production');
  process.exit(1);
}

if (isProd && !process.env.EVE_CLIENT_SECRET) {
  console.error('FATAL: EVE_CLIENT_SECRET must be set in production');
  process.exit(1);
}

// AES-256 needs a 32-byte key. Accept any non-empty string from the env
// and derive a deterministic 32-byte key from it via SHA-256. The one
// special case is "exactly 64 hex characters" — those are used verbatim
// so deployments that previously ran `openssl rand -hex 32` keep the
// same key bytes and existing encrypted tokens still decrypt.

const TOKEN_ENC_RAW = process.env.TOKEN_ENCRYPTION_KEY;
if (!TOKEN_ENC_RAW) {
  console.error('FATAL: TOKEN_ENCRYPTION_KEY must be set (any non-empty string is accepted)');
  process.exit(1);
}
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const tokenEncryptionKey = HEX_64.test(TOKEN_ENC_RAW)
  ? TOKEN_ENC_RAW.toLowerCase()
  : createHash('sha256').update(TOKEN_ENC_RAW).digest('hex');

export const config = {
  corpMode:            CORP_IDS.length > 0,
  corpIds:             CORP_IDS,
  corpMapShared:       CORP_MAP_SHARED,
  adminCharId:         ADMIN_CHAR_ID,
  reportsCharId:       REPORTS_CHAR_ID && Number.isInteger(REPORTS_CHAR_ID) && REPORTS_CHAR_ID > 0 ? REPORTS_CHAR_ID : null,
  corpMapExpireDays:   CORP_MAP_TIME,
  maxUserMaps:         parseInt(process.env.MAX_USER_MAPS ?? '5', 10),
  maxCorpMaps:         parseInt(process.env.MAX_CORP_MAPS ?? '5', 10),
  discord:             DISCORD_WEBHOOKS,
  sessionSecret:       process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  tokenEncryptionKey,
  isProd,
} as const;
