import type { MapConnection } from '../types';
import type { WormholeSpec } from '../hooks/useWormholeTypes';

// Connection wormhole-lifetime model. Mirrors the server copy in
// server/src/data/whLifetimes.ts (lifeBucket / effectiveExpiryMs) so the live
// edge label and the hourly server sweep always land on the same bucket. Keep
// the two in lockstep if the thresholds ever change.

export type TimeBucket = 'fresh' | 'lessThan24h' | 'lessThan4h' | 'lessThan1h' | 'expired';

const HOUR_MS = 3_600_000;
// A legacy eol_at mark means "~4h of life left from when it was marked".
export const EOL_LIFE_MS = 4 * HOUR_MS;

/**
 * The bucket a connection is in given the milliseconds of life it has left.
 * Boundaries are inclusive of the shorter bucket, so a hole flips exactly at the
 * threshold: a fresh 24h static opens at "< 1 day" (never "fresh"), and a 16h
 * hole drops to "< 4h" once 12h have elapsed. Mirrors the server copy.
 */
export function lifeBucket(remainingMs: number): TimeBucket {
  if (remainingMs <= 0)            return 'expired';
  if (remainingMs <= HOUR_MS)      return 'lessThan1h';
  if (remainingMs <= EOL_LIFE_MS)  return 'lessThan4h';
  if (remainingMs <= 24 * HOUR_MS) return 'lessThan24h';
  return 'fresh';
}

/**
 * Estimated collapse time (ms since epoch) for a connection, or null when its
 * lifetime is unknown (untyped, or a bare K162 with no manual override). Priority:
 *   1. manual override (lifetimeExpiresAt) — a user set it, so it always wins;
 *   2. legacy EOL mark (eolAt) — a 4h window from when it was set;
 *   3. auto: createdAt + the wh type's charted max life.
 */
export function effectiveExpiryMs(
  conn: Pick<MapConnection, 'lifetimeExpiresAt' | 'eolAt' | 'type' | 'createdAt'>,
  whTypes: Record<string, WormholeSpec>,
): number | null {
  if (conn.lifetimeExpiresAt) return new Date(conn.lifetimeExpiresAt).getTime();
  if (conn.eolAt)             return new Date(conn.eolAt).getTime() + EOL_LIFE_MS;
  const code = (conn.type ?? '').trim().toUpperCase();
  if (code && code !== 'K162') {
    const h = whTypes[code]?.lifetimeHours;
    if (h) return new Date(conn.createdAt).getTime() + h * HOUR_MS;
  }
  return null;
}

/**
 * The wormhole type's charted max lifetime in hours, or null for an untyped or
 * bare-K162 connection (life unknown). Drives the right-click / panel menus:
 * "Fresh" (life > 24h remaining) is only reachable by a >24h hole, so the menu
 * hides it when this is a known value <= 24.
 */
export function knownMaxLifeHours(
  conn: Pick<MapConnection, 'type'>,
  whTypes: Record<string, WormholeSpec>,
): number | null {
  const code = (conn.type ?? '').trim().toUpperCase();
  if (!code || code === 'K162') return null;
  return whTypes[code]?.lifetimeHours || null;
}
