export type SystemClass =
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C13'
  | 'HS' | 'LS' | 'NS'
  | 'Thera' | 'Pochven' | 'Drifter';

export type WormholeEffect =
  | 'none' | 'pulsar' | 'black_hole' | 'cataclysmic_variable'
  | 'magnetar' | 'red_giant' | 'wolf_rayet';

export type MassStatus = 'stable' | 'destabilized' | 'critical';
export type TimeStatus = 'fresh' | 'eol' | 'lessThan24h' | 'lessThan4h' | 'lessThan1h' | 'expired';
export type ConnectionSize = 'xl' | 'large' | 'medium' | 'small';
export type SystemStatus = 'unknown' | 'visited' | 'cleared';

/** Built-in intel tag values. User-defined custom intel adds arbitrary
 *  ids (UUIDs) alongside these. */
export type BuiltinIntel = 'friendly' | 'hostile' | 'occupied' | 'empty';

/** Manual intel tag — applied by the user via the system right-click menu.
 *  Drives a soft background tint on the node. Distinct from [[SystemStatus]],
 *  which tracks exploration state. */
export type SystemIntel = BuiltinIntel | string;

/** A user-defined intel option stored in their preferences. The id is a
 *  stable UUID — labels and colours can be edited without orphaning the
 *  systems already tagged with it. */
export interface CustomIntel {
  id:    string;
  label: string;
  color: string;
}

export interface MapSystem {
  id: string;
  eveSystemId: number | null;
  name: string;
  systemClass: SystemClass;
  effect: WormholeEffect;
  statics: string[];          // e.g. ['C247', 'Z971']
  regionName: string | null;
  npcType: string | null;
  position: { x: number; y: number };
  status: SystemStatus;
  /** Optional intel tag (friendly/hostile/occupied/empty). Absent on
   *  shared-link views — intel is private to the owning user's chain. */
  intel?: SystemIntel | null;
  isHome: boolean;
  locked: boolean;
  notes: string;
  lastActivityAt: string; // ISO timestamp, updated when system or its sigs are touched
}

export type SigType = 'unknown' | 'wormhole' | 'data' | 'relic' | 'combat' | 'gas' | 'ore';

export interface Signature {
  id: string;
  sigId: string;
  sigType: SigType;
  name: string;
  notes: string;
  whType: string;
  whLeadsTo: string;
  createdAt: string;
  updatedAt: string;
}

export type StructureType =
  | 'unknown'
  | 'astrahus' | 'fortizar' | 'keepstar'
  | 'raitaru' | 'azbel' | 'sotiyo'
  | 'athanor' | 'tatara'
  | 'ansiblex' | 'pharolynx' | 'tenebrex';

export interface Structure {
  id: string;
  name: string;
  structureType: StructureType;
  ownerCorp: string;
  ownerCorpId: number | null; // resolved via ESI on insert; powers standings tint
  eveId: number | null;
  notes: string;
  createdAt: string;
}

export interface NpcStation {
  id: number;
  name: string;
  services: string[];
}

export type ConnectionType = 'standard' | 'jumpgate';

export interface MapConnection {
  id: string;
  sourceId: string;
  targetId: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  type: string | null;
  connectionType: ConnectionType;
  massStatus: MassStatus | null;
  timeStatus: TimeStatus | null;
  size: ConnectionSize;
  massUsed: number; // kg — total mass jumped through this connection
  eolAt: string | null; // ISO timestamp when EOL was marked (null = fresh)
  createdAt: string;
}

export interface WormholeMap {
  id: string;
  name: string;
  isCorpMap?: boolean;
  locked?: boolean;
  /** Corp maps only: whether this map is opted in as a merge source. */
  allowAsMergeSource?: boolean;
  /** Corp maps only: whether this map is opted in as a merge destination. */
  allowAsMergeDestination?: boolean;
  /** Present when the map has an active or expired share link. The token
   *  itself is in shareToken; shareExpiresAt is the cutoff. The owner UI
   *  treats an expired token as "no link" — regenerate to share again.
   *  shareIncludeSigs / shareIncludeBridges are the per-link options the
   *  owner picked at generation time and are frozen for that token's life. */
  shareToken?:              string | null;
  shareExpiresAt?:          string | null;
  shareIncludeSigs?:        boolean;
  shareIncludeBridges?:     boolean;
  shareIncludeNotes?:       boolean;
  shareIncludeStructures?:  boolean;
  systems: MapSystem[];
  connections: MapConnection[];
  createdAt: string;
  updatedAt: string;
}
