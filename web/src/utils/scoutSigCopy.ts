// Turning an eve-scout connection into signature rows for the map.
//
// eve-scout already knows what a scout would otherwise retype by hand: the
// signature id at each end, the hole's type, and how big it is. This works out
// which of those belong on the map and what each row should say.
//
import { lifeBucket } from './whLifetime';
import type { ConnectionSize, TimeStatus } from '../types';

// Names come from eve-scout's point of view, which is the HUB's: "out" is the
// signature inside Thera/Turnur that you warp to in order to leave, "in" is the
// one in the system at the far end.

/** The parts of a scout connection this needs. */
export interface ScoutLike {
  whType:        string;
  maxShipSize:   string;
  remainingHours: number | null;
  inSystemId:    number;
  inSystemName:  string;
  inSignature:   string | null;
  outSignature:  string | null;
}

/** The parts of a mapped system this needs. */
export interface MappedSystem {
  id:           string;
  name:         string;
  eveSystemId:  number | null;
}

/** One signature to write. */
export interface SigWrite {
  systemId:   string;   // map system id
  systemName: string;
  sigId:      string;
  whType:     string;
  whLeadsTo:  string;
  /** '' when the feed gives no lifetime, which leaves the field unset rather
   *  than asserting a state nobody has observed. */
  timeStatus: TimeStatus | '';
}

/**
 * eve-scout's remaining hours as the app's life bucket.
 *
 * Routed through the same lifeBucket the rest of the app uses, so a hole
 * copied from the feed lands in the same bucket a scout would have set by
 * hand, and the thresholds cannot drift apart.
 */
export function scoutTimeStatus(remainingHours: number | null | undefined): TimeStatus | '' {
  if (remainingHours == null || !Number.isFinite(remainingHours)) return '';
  return lifeBucket(remainingHours * 3_600_000);
}

/** eve-scout's size vocabulary, as the connection size values used here.
 *  Typed to the union so an unmapped word cannot reach a connection. */
const SIZE_FROM_SCOUT: Record<string, ConnectionSize> = {
  small: 'small', medium: 'medium', large: 'large', xlarge: 'xl',
};

export function scoutSizeToConnSize(maxShipSize: string): ConnectionSize | null {
  return SIZE_FROM_SCOUT[(maxShipSize ?? '').toLowerCase()] ?? null;
}

/**
 * The signature rows a connection contributes, for whichever of its two ends
 * are on the map.
 *
 * Both ends are considered, not just the far one: if the hub itself has been
 * added to the map then its exit signature is just as much a thing somebody
 * would otherwise type in. A connection with neither end mapped contributes
 * nothing, which is what "only populate systems on the map" means.
 *
 * A row is skipped when eve-scout has no signature id for that end -- a
 * half-known hole is reported with one side blank, and an empty sig id would
 * write a nameless row that is worse than no row.
 */
export function sigWritesFor(
  conn: ScoutLike, systems: MappedSystem[], hubName: string,
): SigWrite[] {
  const out: SigWrite[] = [];

  const far = systems.find((s) => s.eveSystemId === conn.inSystemId);
  if (far && conn.inSignature) {
    out.push({
      systemId: far.id, systemName: far.name,
      sigId: conn.inSignature, whType: conn.whType, whLeadsTo: hubName,
      timeStatus: scoutTimeStatus(conn.remainingHours),
    });
  }

  // The hub is matched by NAME: Thera and Turnur are single known systems, and
  // the feed does not carry the hub's own id on the row.
  const hub = systems.find((s) => s.name.toLowerCase() === hubName.toLowerCase());
  if (hub && conn.outSignature) {
    out.push({
      systemId: hub.id, systemName: hub.name,
      sigId: conn.outSignature, whType: conn.whType, whLeadsTo: conn.inSystemName,
      timeStatus: scoutTimeStatus(conn.remainingHours),
    });
  }

  return out;
}

/** Key for "this signature already exists in this system". */
export function sigKey(systemId: string, sigId: string): string {
  return `${systemId}:${sigId.trim().toUpperCase()}`;
}

/**
 * Every signature row `conns` implies, for the ends that are mapped.
 *
 * Deliberately NOT filtered against what is already on the map. Copying is an
 * upsert: a row somebody deleted by accident should come back, and a hole whose
 * remaining life has moved on since the last copy should be brought up to date.
 * Filtering here would make the button go quiet in exactly the two cases where
 * pressing it again is the point.
 *
 * Deduped within the batch, since two feed entries can name the same signature.
 */
export function allSigWrites(
  conns: ScoutLike[], systems: MappedSystem[], hubName: string,
): SigWrite[] {
  const seen = new Set<string>();
  const out: SigWrite[] = [];
  for (const c of conns) {
    for (const w of sigWritesFor(c, systems, hubName)) {
      const k = sigKey(w.systemId, w.sigId);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
  }
  return out;
}

/** A wormhole to draw between two mapped systems. */
export interface ConnWrite {
  fromId:     string;   // the far system's map id
  toId:       string;   // the hub's map id
  whType:     string;
  size:       ConnectionSize | null;
  timeStatus: TimeStatus | '';
}

/**
 * The connection a scout entry implies, when BOTH of its ends are on the map.
 *
 * Only then: a hole needs two nodes to join, and inventing the missing one
 * would be adding systems to somebody's map as a side effect of copying
 * signatures. Returns null otherwise, which is the common case.
 *
 * Size comes from eve-scout's own max-ship-size rather than being inferred
 * from the type, because the feed reports it directly and a K162 at the hub
 * end carries no type to infer from.
 */
export function connWriteFor(
  conn: ScoutLike, systems: MappedSystem[], hubName: string,
): ConnWrite | null {
  const far = systems.find((s) => s.eveSystemId === conn.inSystemId);
  const hub = systems.find((s) => s.name.toLowerCase() === hubName.toLowerCase());
  if (!far || !hub || far.id === hub.id) return null;
  return {
    fromId: far.id, toId: hub.id,
    whType: conn.whType,
    size: scoutSizeToConnSize(conn.maxShipSize),
    timeStatus: scoutTimeStatus(conn.remainingHours),
  };
}

/** Every connection `conns` implies, deduped by the pair of systems. */
export function allConnWrites(
  conns: ScoutLike[], systems: MappedSystem[], hubName: string,
): ConnWrite[] {
  const seen = new Set<string>();
  const out: ConnWrite[] = [];
  for (const c of conns) {
    const w = connWriteFor(c, systems, hubName);
    if (!w) continue;
    const k = pairKey(w.fromId, w.toId);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/** Order-independent key for "a connection between these two systems". */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
