import type { MapConnection, MassStatus, Signature, TimeStatus } from '../types';
import type { WormholeSpec } from '../hooks/useWormholeTypes';
import { effectiveExpiryMs, lifeBucket } from './whLifetime';

/**
 * A wormhole is one physical hole described by three rows: a signature each
 * side, and the connection between them. Its mass and life belong to the hole,
 * not to any one of those rows, so they need a single home.
 *
 * The connection is that home whenever one exists — which makes both ends agree
 * for free, since each sig is reading the same row. Before the hole has been
 * jumped there is no connection, so the observation is staged on the signature
 * (you can read both values off a hole in space without going through it) and
 * handed over when the connection appears.
 */

export interface WhState {
  massStatus: MassStatus | '';
  timeStatus: TimeStatus | '';
}

/**
 * A hole's life is tracked as an EXPIRY, with the warning bucket derived from
 * it — there is no 'eol' bucket to set. ('eolAt' is a legacy column nothing
 * writes any more.) So recording a life state means writing the expiry.
 */

/** The connection backing a signature, if one has been linked to it. */
export function connectionForSig(
  sigId: string,
  connections: MapConnection[],
): MapConnection | undefined {
  return connections.find(
    (c) => c.sourceSignatureId === sigId || c.targetSignatureId === sigId,
  );
}

/**
 * What to SHOW for a signature: the connection's state, else its own staging.
 *
 * The life bucket is DERIVED from the hole's expiry, exactly as the map edge
 * derives it — not read from the stored `timeStatus`. The two can drift (a hole
 * ages past its stored bucket, or an older write set a bucket without an
 * expiry), and when they do, the table and the map disagree in front of the
 * user. One source, one answer.
 */
export function effectiveWhState(
  sig: Signature,
  conn: MapConnection | undefined,
  whTypes: Record<string, WormholeSpec> = {},
  now: number = Date.now(),
): WhState {
  if (conn) {
    // A connection spells "nothing noted" as stable/fresh; the sig cell spells
    // it blank. Normalise both, or the chip can't find its place in the cycle
    // and sticks on its first value.
    const mass = conn.massStatus ?? '';
    const expiry = effectiveExpiryMs(conn, whTypes);
    // No known lifetime (untyped hole) → fall back to whatever bucket is stored.
    const bucket = expiry != null
      ? lifeBucket(expiry - now)
      : ((conn.timeStatus ?? '') as TimeStatus | '');
    return {
      massStatus: mass === 'stable' ? '' : (mass as MassStatus | ''),
      // 'fresh' means nothing worth showing; every warning bucket is shown as
      // itself so the chip reads the same as the edge label.
      timeStatus: bucket === 'fresh' ? '' : bucket,
    };
  }
  return { massStatus: sig.massStatus ?? '', timeStatus: sig.timeStatus ?? '' };
}

/**
 * Staged state worth carrying onto a connection that has just been linked —
 * null when the sig noted nothing, so an empty observation can't wipe a value
 * already recorded on the connection from the other side.
 */
export function pendingWhState(sig: Signature): Partial<WhState> | null {
  const patch: Partial<WhState> = {};
  if (sig.massStatus) patch.massStatus = sig.massStatus;
  if (sig.timeStatus) patch.timeStatus = sig.timeStatus;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The hours of life each bucket represents. Marking a bucket sets the expiry
 * that far out; the bucket itself is derived from the expiry, so writing it on
 * its own is recomputed away within seconds.
 */
const BUCKET_HOURS: Partial<Record<TimeStatus, number>> = {
  lessThan24h: 24,
  lessThan4h:  4,
  lessThan1h:  1,
  // 0 hours puts the expiry in the past once the inset below is applied, which
  // is what 'expired' means — the same state a hole reaches on its own when its
  // clock runs out, rather than a separate flag.
  expired:     0,
};

/**
 * Life states the chip cycles through: unknown, EVE's three warnings, then
 * expired. A hole reaches 'expired' on its own when its clock runs out, and the
 * chip has always been able to show it — this is what lets someone SET it, for
 * the hole they watched collapse.
 */
export const LIFE_CYCLE: Array<TimeStatus | ''> = ['', 'lessThan24h', 'lessThan4h', 'lessThan1h', 'expired'];

/**
 * The connection patch for a chosen life bucket, or for clearing back to
 * unknown — which restores the hole's full life when its type is known, and
 * otherwise just drops the manual expiry so it ages naturally again.
 */
export function lifePatch(
  bucket: TimeStatus | '',
  conn: Pick<MapConnection, 'type'>,
  whTypes: Record<string, { lifetimeHours?: number }> = {},
): Partial<MapConnection> {
  // Land just INSIDE the bucket, not exactly on its edge. The boundary test is
  // inclusive (<=), and the map edge only re-reads the clock every 30s — so an
  // expiry set to exactly 4h reads as "a shade over 4h" there and renders as
  // the bucket above, leaving the table and the map disagreeing.
  const INSET_MS = 60_000;
  const inMs = (h: number) => new Date(Date.now() + h * 3_600_000 - INSET_MS).toISOString();
  // `?? undefined` rather than a truthiness test: 'expired' is 0 hours, and a
  // falsy check would send it down the "clear back to unknown" path instead.
  const hours = bucket ? BUCKET_HOURS[bucket] ?? undefined : undefined;
  if (hours != null) {
    return { timeStatus: bucket as TimeStatus, eolAt: null, lifetimeExpiresAt: inMs(hours) };
  }
  const code = (conn.type ?? '').trim().toUpperCase();
  const maxLife = code ? (code === 'K162' ? 24 : whTypes[code]?.lifetimeHours ?? null) : null;
  return { timeStatus: 'fresh', eolAt: null, lifetimeExpiresAt: maxLife ? inMs(maxLife) : null };
}
