// Deployment-level key/value settings (app_settings table). Distinct from the
// per-user ui_settings blob — these are instance-wide and admin-managed.
import { db } from '../db.js';

async function getSetting(key: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string, userId: number | null): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by_user)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by_user = EXCLUDED.updated_by_user`,
    [key, value, userId],
  );
}

// ── Standings auto-admit ("friends") settings — Phase 3 ──────────────────────
export const STANDINGS_LOGIN_ENABLED   = 'standings_login_enabled';
export const STANDINGS_LOGIN_THRESHOLD = 'standings_login_threshold';

// Only the two in-game friendly levels are valid thresholds (design 4.0). Off by
// default; a threshold of 10 (stricter) is the default when none is stored.
export type StandingsThreshold = 5 | 10;
export interface StandingsLoginSettings {
  enabled:   boolean;
  threshold: StandingsThreshold;
}

export async function getStandingsLoginSettings(): Promise<StandingsLoginSettings> {
  const [enabledRaw, thresholdRaw] = await Promise.all([
    getSetting(STANDINGS_LOGIN_ENABLED),
    getSetting(STANDINGS_LOGIN_THRESHOLD),
  ]);
  return {
    enabled:   enabledRaw === 'true',
    threshold: thresholdRaw === '5' ? 5 : 10,
  };
}
