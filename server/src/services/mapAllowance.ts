import { db } from '../db.js';
import { config } from '../config.js';

/**
 * How many PERSONAL maps an account may hold.
 *
 * The base is MAX_USER_MAPS. On an unrestricted install with ISK-for-maps
 * enabled, donations to the nominated corporation raise it (see
 * services/iskDonations.ts), and an admin can adjust it by hand on top.
 *
 * Entitlement ACCUMULATES rather than counting donations:
 *
 *     base + floor(total donated / price) * mapsPerGrant + manual bonus
 *
 * so two half payments earn a grant and a double payment earns two, instead of
 * either being quietly discarded. Derived on read rather than stored, so there
 * is one source of truth and a corrected donation row can never leave a stale
 * allowance behind.
 */
export async function mapCapFor(ownerId: number | null): Promise<number> {
  const base = config.maxUserMaps;
  if (ownerId == null) return base;

  // The manual bonus applies whatever the install; only the donation half is
  // gated, so disabling the feature can't strip an allowance an admin granted.
  const { rows } = await db.query<{ donated: string | null; bonus: number | null }>(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM isk_donations WHERE owner_id = $1) AS donated,
            (SELECT map_bonus FROM owners WHERE id = $1)                             AS bonus`,
    [ownerId],
  );

  const bonus = rows[0]?.bonus ?? 0;
  if (!config.iskMaps.enabled) return Math.max(0, base + bonus);

  // NUMERIC comes back as a string; it is money, so parse it explicitly rather
  // than letting it coerce somewhere further down.
  const donated = Number(rows[0]?.donated ?? 0);
  const grants  = Number.isFinite(donated) && donated > 0
    ? Math.floor(donated / config.iskMaps.priceIsk)
    : 0;

  return Math.max(0, base + grants * config.iskMaps.mapsPerGrant + bonus);
}

/** What an account has earned and spent, for the "Get more maps" modal. */
export interface MapAllowance {
  used:      number;
  cap:       number;
  base:      number;
  /** Total ISK matched to this account. */
  donated:   number;
  /** ISK still needed for the next grant — what the modal counts down. */
  toNext:    number;
  priceIsk:  number;
  perGrant:  number;
  enabled:   boolean;
}

export async function mapAllowanceFor(ownerId: number | null): Promise<MapAllowance> {
  const [cap, used, donated] = await Promise.all([
    mapCapFor(ownerId),
    countPersonalMaps(ownerId),
    totalDonated(ownerId),
  ]);
  const price = config.iskMaps.priceIsk;
  return {
    used, cap,
    base:     config.maxUserMaps,
    donated,
    toNext:   price - (donated % price),
    priceIsk: price,
    perGrant: config.iskMaps.mapsPerGrant,
    enabled:  config.iskMaps.enabled,
  };
}

export async function countPersonalMaps(ownerId: number | null): Promise<number> {
  if (ownerId == null) return 0;
  const { rowCount } = await db.query(
    `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`,
    [ownerId],
  );
  return rowCount ?? 0;
}

async function totalDonated(ownerId: number | null): Promise<number> {
  if (ownerId == null) return 0;
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM isk_donations WHERE owner_id = $1`, [ownerId],
  );
  return Number(rows[0]?.total ?? 0);
}
