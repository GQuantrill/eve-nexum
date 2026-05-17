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
  systems: MapSystem[];
  connections: MapConnection[];
  createdAt: string;
  updatedAt: string;
}
