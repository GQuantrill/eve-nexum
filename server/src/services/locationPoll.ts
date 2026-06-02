import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { getValidToken } from '../utils/eveToken.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('locationPoll');

// Mirror of routes/character.ts isReallyOnline — ESI's `online` flag lags on
// log-out, so cross-check last_login >= last_logout.
interface OnlineResp { online?: boolean; last_login?: string; last_logout?: string }
function reallyOnline(d: OnlineResp): boolean {
  if (!d?.online) return false;
  if (!d.last_login || !d.last_logout) return true;
  const lin = new Date(d.last_login).getTime();
  const lout = new Date(d.last_logout).getTime();
  if (!Number.isFinite(lin) || !Number.isFinite(lout)) return true;
  return lin >= lout;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Refresh one character's last_known_system from ESI (only when online — an
// offline character keeps its existing last known system). No jump events:
// background detection shouldn't inflate a pilot's activity stats.
async function pollOne(userId: number, characterId: number): Promise<void> {
  const token = await getValidToken(userId); // throws on a dead/revoked token
  const onlineRes = await esiFetch(
    `https://esi.evetech.net/latest/characters/${characterId}/online/`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!onlineRes.ok) return;
  if (!reallyOnline(await onlineRes.json() as OnlineResp)) return;

  const locRes = await esiFetch(
    `https://esi.evetech.net/latest/characters/${characterId}/location/`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!locRes.ok) return;
  const { solar_system_id } = await locRes.json() as { solar_system_id: number };
  await db.query(
    `UPDATE users SET last_known_system_id = $1, last_known_system_at = NOW()
       WHERE id = $2 AND last_known_system_id IS DISTINCT FROM $1`,
    [solar_system_id, userId],
  );
}

let running = false;
async function pollAll(): Promise<void> {
  if (running) return; // never overlap cycles
  running = true;
  try {
    // Only recently-active characters — avoids hammering ESI (and refreshing
    // tokens) for long-dormant accounts whose tokens are probably dead anyway.
    const { rows } = await db.query<{ id: number; character_id: number }>(
      `SELECT id, character_id FROM users
        WHERE refresh_token IS NOT NULL AND updated_at > NOW() - interval '30 days'
        ORDER BY id`,
    );
    let ok = 0, skipped = 0;
    for (const r of rows) {
      try { await pollOne(r.id, r.character_id); ok++; }
      catch { skipped++; } // dead token / ESI hiccup — skip quietly
      await sleep(250);    // gentle on ESI between characters
    }
    if (rows.length) log.info(`location poll: ${ok} updated/ok, ${skipped} skipped of ${rows.length}`);
  } catch (err) {
    log.error('location poll cycle failed:', err);
  } finally {
    running = false;
  }
}

/**
 * Start the background last-known-location poller if LOCATION_POLL_MINUTES > 0.
 * Opt-in at the deployment level — it reads the location of every recently
 * active linked character (corp members, in corp mode), so it's only enabled
 * where that's wanted.
 */
export function startLocationPoller(): void {
  const mins = config.locationPollMinutes;
  if (mins <= 0) return;
  log.info(`background location poller enabled (every ${mins} min)`);
  setTimeout(() => { void pollAll(); }, 30_000);      // first run shortly after boot
  setInterval(() => { void pollAll(); }, mins * 60_000);
}
