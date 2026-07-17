import { createHash, randomBytes } from 'node:crypto';

// CORP_ID accepts a comma-separated list of corporation IDs. Any member of
// any listed corp is allowed to log in.
const CORP_IDS: number[] = (process.env.CORP_ID ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isInteger(n) && n > 0);

// ALLIANCE_ID accepts a comma-separated list of alliance IDs, mirroring
// CORP_ID. Any member of any listed alliance is allowed to log in, and the
// list doubles as the coalition set for alliance-map sharing. Lets a whole
// alliance be permitted without enumerating every member corp.
const ALLIANCE_IDS: number[] = (process.env.ALLIANCE_ID ?? '')
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

// Alliance-map counterpart of CORP_MAP_SHARED. When true, every member of any
// listed alliance sees every alliance map (coalition mode). When false
// (default), an alliance map is visible only to members of the alliance that
// owns it.
const ALLIANCE_MAP_SHARED = /^(1|true|yes)$/i.test(process.env.ALLIANCE_MAP_SHARED ?? '');

// A restricted (non-solo) deployment — corp OR alliance gated — needs a
// bootstrap admin so someone can always administer it.
if ((CORP_IDS.length > 0 || ALLIANCE_IDS.length > 0) && ADMIN_CHAR_ID === null) {
  console.error('FATAL: CORP_ID / ALLIANCE_ID is set but ADMIN_CHAR_ID is missing');
  process.exit(1);
}

// Daily SDE auto-update. On by default — the server checks once a day for a new
// CCP SDE build and re-seeds only if it changed. Disable with SDE_AUTO_UPDATE=0.
// SDE_CHECK_UTC (HH:MM, default 11:30) is when to check: EVE downtime is 11:00
// UTC and CCP publishes the export shortly after, so we look a little later.
const SDE_AUTO_UPDATE = !/^(0|false|no|off)$/i.test(process.env.SDE_AUTO_UPDATE ?? '');
const SDE_CHECK_UTC   = /^\d{1,2}:\d{2}$/.test(process.env.SDE_CHECK_UTC ?? '')
  ? process.env.SDE_CHECK_UTC!
  : '11:30';

const isProd = process.env.NODE_ENV === 'production';
const isDev  = process.env.NODE_ENV === 'development';

// Session secret must be explicitly set unless we're explicitly in development
// — the guessable dev fallback below is a session-forgery risk, so it must
// never apply just because NODE_ENV happens to be unset on a real deployment.
if (!isDev && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set (NODE_ENV is not "development")');
  process.exit(1);
}

// FRONTEND_URL builds post-login redirects and seeds the CSRF origin check, so
// a malformed value would silently break auth / weaken that check. Validate the
// effective value (default is the local dev URL) before anything uses it.
if (!URL.canParse(process.env.FRONTEND_URL ?? 'http://localhost:5174')) {
  console.error('FATAL: FRONTEND_URL is not a valid URL');
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
const isHex64Key = HEX_64.test(TOKEN_ENC_RAW);
// A short passphrase SHA-256s into a low-entropy, brute-forceable key that
// protects every stored EVE refresh token. The strong form is 64 hex chars
// (`openssl rand -hex 32`). We only WARN about weaker keys — never refuse to
// boot — so self-hosted deployments that already run with a short passphrase
// keep starting. Operators are nudged to upgrade but not locked out.
if (!isHex64Key && TOKEN_ENC_RAW.length < 32) {
  console.warn('WARNING: TOKEN_ENCRYPTION_KEY is weak — for stronger token encryption use 64 hex chars (openssl rand -hex 32) or at least a 32-character passphrase');
}
const tokenEncryptionKey = isHex64Key
  ? TOKEN_ENC_RAW.toLowerCase()
  : createHash('sha256').update(TOKEN_ENC_RAW).digest('hex');

// Opt-in anonymous deployment ping. OFF by default — a self-hosted instance
// phones home to nobody unless the operator opts in. When on, the server sends
// only { version, instanceId } once a day so the project can count active
// installs. Two ways to opt in:
//   - NEXUM_TELEMETRY=1 (uses the default eve-nexum.com collector), or
//   - simply setting NEXUM_TELEMETRY_URL to a non-empty value — populating a
//     collector endpoint is itself treated as consent (comment it out / leave it
//     unset to stay opted out).
// Key off the RAW env var here, not the resolved URL below: the resolved URL
// always falls back to the default, so testing it would opt everyone in.
const TELEMETRY_URL_SET = (process.env.NEXUM_TELEMETRY_URL ?? '').trim().length > 0;
const TELEMETRY_ENABLED = /^(1|true|yes|on)$/i.test(process.env.NEXUM_TELEMETRY ?? '') || TELEMETRY_URL_SET;
const TELEMETRY_URL = process.env.NEXUM_TELEMETRY_URL?.trim() || 'https://eve-nexum.com/api/telemetry';

export const config = {
  corpMode:            CORP_IDS.length > 0,
  corpIds:             CORP_IDS,
  corpMapShared:       CORP_MAP_SHARED,
  allianceMode:        ALLIANCE_IDS.length > 0,
  allianceIds:         ALLIANCE_IDS,
  allianceMapShared:   ALLIANCE_MAP_SHARED,
  // True for any non-solo deployment (corp- or alliance-gated). Drives role
  // enforcement, map scoping and the idle-map sweep — everything that must be
  // OFF in a wide-open solo install but ON the moment logins are restricted.
  restrictedMode:      CORP_IDS.length > 0 || ALLIANCE_IDS.length > 0,
  adminCharId:         ADMIN_CHAR_ID,
  reportsCharId:       REPORTS_CHAR_ID && Number.isInteger(REPORTS_CHAR_ID) && REPORTS_CHAR_ID > 0 ? REPORTS_CHAR_ID : null,
  corpMapExpireDays:   CORP_MAP_TIME,
  maxUserMaps:         parseInt(process.env.MAX_USER_MAPS ?? '5', 10),
  maxCorpMaps:         parseInt(process.env.MAX_CORP_MAPS ?? '5', 10),
  maxAllianceMaps:     parseInt(process.env.MAX_ALLIANCE_MAPS ?? '5', 10),
  // Background last-known-location poller (multi-account). 0 / unset = disabled
  // (opt-in at the deployment level). When > 0, every linked character's
  // last_known_system is refreshed from ESI on this cadence so positions stay
  // current without anyone being logged into Nexum.
  locationPollMinutes: Math.max(0, parseInt(process.env.LOCATION_POLL_MINUTES ?? '0', 10) || 0),
  // Cadence (minutes) of the login-access re-validation sweep, which evicts live
  // sessions the current gate no longer permits (standings toggled off/tightened,
  // a standing drifting below threshold, or leaving an admitted corp). Restricted
  // deployments only. Default 60; set to 0 to disable the periodic sweep (an
  // admin settings change still sweeps immediately).
  accessRevalidateMinutes: (() => {
    const n = parseInt(process.env.ACCESS_REVALIDATE_MINUTES ?? '60', 10);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  })(),
  // Cadence (minutes) of the lazy wormhole-removal sweep, which deletes aged-out
  // WH sigs (and quarantines the connections they backed) on maps that have
  // opted in. Default 15; set to 0 to disable the sweep globally.
  lazyWhSweepMinutes:  (() => {
    const n = parseInt(process.env.LAZY_WH_SWEEP_MINUTES ?? '15', 10);
    return Number.isFinite(n) && n >= 0 ? n : 15;
  })(),
  // Cadence (minutes) of the connection-lifetime sweep, which re-buckets each
  // wormhole connection's time status (fresh / <1d / <4h / <1h / expired) from
  // its age so holes visibly decay on their own. Default 60; 0 disables it.
  connLifetimeSweepMinutes: (() => {
    const n = parseInt(process.env.CONN_LIFETIME_SWEEP_MINUTES ?? '60', 10);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  })(),
  // Grace period (hours) a connection stays past its expiry before the lifetime
  // sweep collapses it — severs it (broken) and deletes its backing wormhole
  // sigs — on maps opted into lazy wormhole removal. A buffer so a hole that
  // lingers slightly past the estimate isn't cut early. Default 2.
  connCollapseGraceHours: (() => {
    const n = parseFloat(process.env.CONN_COLLAPSE_GRACE_HOURS ?? '2');
    return Number.isFinite(n) && n >= 0 ? n : 2;
  })(),
  sdeAutoUpdate:       SDE_AUTO_UPDATE,
  sdeCheckUtc:         SDE_CHECK_UTC,
  telemetry:           { enabled: TELEMETRY_ENABLED, url: TELEMETRY_URL },
  // Required in non-dev (guarded above). The dev fallback is randomised per
  // boot rather than a known literal, so a dev instance accidentally exposed
  // can't have its sessions forged with a guessable secret (sessions just
  // don't survive a restart in dev, which is fine).
  sessionSecret:       process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
  tokenEncryptionKey,
  isProd,
} as const;
