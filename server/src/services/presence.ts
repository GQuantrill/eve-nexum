import { publishToMap } from './mapEvents.js';

// Ephemeral "who's viewing this map and where are they" roster. Never
// persisted — in-memory per map, expired by TTL / disconnect. Rides the same
// SSE fan-out as map edits. See presence_feature.md.
export interface PresenceEntry {
  characterId:   number;
  characterName: string;
  eveSystemId:   number | null;  // current system; null = unknown / docked elsewhere
  shipTypeId:    number | null;
  ts:            number;          // last heartbeat (ms)
}

const TTL_MS    = 60_000;
const SWEEP_MS  = 30_000;

const rosters = new Map<string, Map<number, PresenceEntry>>();

// Upsert a viewer's location and fan it out to the map room.
export function reportPresence(
  mapId: string,
  entry: Omit<PresenceEntry, 'ts'>,
  actor: string | null,
): void {
  let roster = rosters.get(mapId);
  if (!roster) { roster = new Map(); rosters.set(mapId, roster); }
  const full: PresenceEntry = { ...entry, ts: Date.now() };
  roster.set(entry.characterId, full);
  publishToMap(mapId, { type: 'presence.update', actor, ...full });
}

// Drop a viewer (left the map / disconnected) and notify the room.
export function removePresence(mapId: string, characterId: number): void {
  const roster = rosters.get(mapId);
  if (!roster || !roster.has(characterId)) return;
  roster.delete(characterId);
  if (roster.size === 0) rosters.delete(mapId);
  publishToMap(mapId, { type: 'presence.leave', characterId });
}

// Current roster for a map — sent to a client when it first connects.
export function presenceSnapshot(mapId: string): PresenceEntry[] {
  const roster = rosters.get(mapId);
  return roster ? [...roster.values()] : [];
}

// Expire stale entries (a client that stopped heart-beating without a clean
// disconnect). The backstop behind the SSE close handler.
const sweep = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [mapId, roster] of rosters) {
    for (const [characterId, entry] of roster) {
      if (entry.ts < cutoff) {
        roster.delete(characterId);
        publishToMap(mapId, { type: 'presence.leave', characterId });
      }
    }
    if (roster.size === 0) rosters.delete(mapId);
  }
}, SWEEP_MS);
sweep.unref?.();
