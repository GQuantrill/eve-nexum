import { useMapStore } from '../store/mapStore';
import { useCharacterLocation, type CharacterLocationSystem } from './useCharacterLocation';
import { useCanTrackJumps } from './useCanEdit';
import { useUserSetting } from './useUserSetting';

// Why the system you're in isn't on the open map. Tracking skips a system
// quietly (useLocationTracking), which left pilots with no "you are here" box,
// no signature panel and no idea why. This names the reason so the map can say
// so, and whether you may add the system yourself.
export type OffMapReason =
  | 'kspaceMap'    // corp/alliance map set by its admins to skip K-space
  | 'kspaceYou'    // your own "don't track K-space" setting (personal maps)
  | 'trackingOff'  // you switched jump tracking off
  | 'readOnly'     // you can view this map but not add to it
  | 'locked';      // the map is locked

const KSPACE = new Set(['HS', 'LS', 'NS']);

export interface OffMap {
  system: CharacterLocationSystem;
  reason: OffMapReason;
  /** You may put it on the map yourself. */
  canAdd: boolean;
}

/** Same order the tracker decides in: a locked map or no right to add stops
 *  everything; then tracking off; then the K-space rule. Null when tracking
 *  will add the system itself on the next location read. */
export function offMapReason(o: {
  systemClass: string; locked: boolean; canTrack: boolean; trackJumps: boolean;
  orgMap: boolean; mapSkip: boolean; mySkip: boolean;
}): OffMapReason | null {
  if (o.locked) return 'locked';
  if (!o.canTrack) return 'readOnly';
  if (!o.trackJumps) return 'trackingOff';
  if (KSPACE.has(o.systemClass) && (o.orgMap ? o.mapSkip : o.mySkip)) return o.orgMap ? 'kspaceMap' : 'kspaceYou';
  return null;
}

export function useOffMapReason(): OffMap | null {
  const { online, system } = useCharacterLocation();
  const mapId      = useMapStore((s) => s.map.id);
  const systems    = useMapStore((s) => s.map.systems);
  const locked     = useMapStore((s) => !!s.map.locked);
  const orgMap     = useMapStore((s) => !!s.map.isCorpMap || !!s.map.isAllianceMap);
  const mapSkip    = useMapStore((s) => !!s.map.skipKspace);
  const trackJumps = useMapStore((s) => s.trackJumps);
  const canTrack   = useCanTrackJumps();
  const [mySkip]   = useUserSetting<boolean>('nexum.tracking.skipKspace', false);

  if (!mapId || !online || !system) return null;
  if (systems.some((s) => s.eveSystemId === system.eveSystemId)) return null;

  const reason = offMapReason({
    systemClass: system.systemClass, locked, canTrack, trackJumps, orgMap, mapSkip, mySkip,
  });
  if (!reason) return null;
  return { system, reason, canAdd: !locked && canTrack };
}
