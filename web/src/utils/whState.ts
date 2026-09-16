import type { MapConnection, MassStatus, Signature, TimeStatus } from '../types';

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

/** What to SHOW for a signature: the connection's state, else its own staging. */
export function effectiveWhState(sig: Signature, conn: MapConnection | undefined): WhState {
  if (conn) {
    // A connection spells "nothing noted" as stable/fresh; the sig cell spells
    // it blank. Normalise both, or the chip can't find its place in the cycle
    // and sticks on its first value.
    const mass = conn.massStatus ?? '';
    const time = conn.timeStatus ?? '';
    return {
      massStatus: mass === 'stable' ? '' : (mass as MassStatus | ''),
      // 'fresh' means nothing worth showing; every warning bucket is shown as
      // itself so the chip reads the same as the edge label.
      timeStatus: time === 'fresh' ? '' : (time as TimeStatus | ''),
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
};

/** Life states the chip cycles through: unknown, then EVE's three warnings. */
export const LIFE_CYCLE: Array<TimeStatus | ''> = ['', 'lessThan24h', 'lessThan4h', 'lessThan1h'];

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
  const inMs = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const hours = bucket ? BUCKET_HOURS[bucket] : undefined;
  if (hours != null) {
    return { timeStatus: bucket as TimeStatus, eolAt: null, lifetimeExpiresAt: inMs(hours) };
  }
  const code = (conn.type ?? '').trim().toUpperCase();
  const maxLife = code ? (code === 'K162' ? 24 : whTypes[code]?.lifetimeHours ?? null) : null;
  return { timeStatus: 'fresh', eolAt: null, lifetimeExpiresAt: maxLife ? inMs(maxLife) : null };
}
