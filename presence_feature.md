# Map Presence — Design

## 1. Goal

Show a live dot for **anyone viewing the same map** (opt-in), placed on the
system they're currently in — not limited to fleet members. Answers "who in the
corp is in/around this chain right now." Rides the SSE transport from
[realtime_sync_feature.md]; presence is **ephemeral** (never persisted).

Complements the existing fleet dots: presence covers *Nexum users with the map
open*; fleet covers *everyone in the fleet incl. non-users* (read via the boss).
Different sets — both can run.

## 2. Core model

ESI has no push and you can't poll someone else's location, so presence works by
**each client reporting its own location, and the server fanning it out** to the
map room:

1. A client viewing map X, **with location tracking opted in**, reports its
   current `eveSystemId` to the server (on location change + a periodic
   heartbeat). It already knows this from `useLocationTracking`/
   `useCharacterLocation`.
2. The server upserts it into an in-memory per-map roster and broadcasts a
   `presence.update` to map X's SSE room.
3. Every viewer of map X renders the dot on the matching node.

**Gating (both already exist):** the SSE room is access-checked (you only see
presence for maps you can see), and location tracking is **opt-in** — a viewer
with tracking off still sees others but doesn't broadcast themselves.

## 3. Server

### 3.1 Registry — `services/presence.ts`
- `Map<mapId, Map<characterId, Entry>>` where
  `Entry = { characterId, characterName, eveSystemId, shipTypeId?, ts }`.
- `report(mapId, entry)` — upsert with `ts = now`, then
  `publishToMap(mapId, { type: 'presence.update', actor, ...entry })`.
- `remove(mapId, characterId)` — delete, then publish `presence.leave`.
- `snapshot(mapId)` — current roster (for a newly-connecting client).
- **TTL sweep**: `setInterval` (~30 s) drops entries older than ~60 s and
  publishes `presence.leave` for each. Single-process, same as the SSE registry.

### 3.2 Endpoints
- `POST /api/maps/:mapId/presence` — body `{ eveSystemId, shipTypeId? }`.
  `getMapAccess` only (viewing is enough — even a readonly corp member can show
  presence). Server attaches `characterId`/`characterName` from the session
  (client never asserts identity). Calls `report(...)`. Returns 204.
- `DELETE /api/maps/:mapId/presence` — best-effort leave (sent via
  `navigator.sendBeacon` on unload / map switch). Calls `remove(...)`.

### 3.3 Snapshot on connect
In the existing `GET /:mapId/events` handler, right after `subscribeMap`, write a
`presence.snapshot` event with `snapshot(mapId)` so a new viewer sees who's
already present immediately (rather than waiting for the next heartbeat).

### 3.4 Clear on disconnect
On the SSE `req.close`, also `remove(mapId, <that user's characterId>)` for a
snappy "left" (TTL is the backstop for multi-tab / missed closes).

## 4. Client

### 4.1 Reporting own location
Extend `useLocationTracking` (it already tracks the player's `eveSystemId`): when
there's an active map **and** tracking is on, `POST …/presence` on each location
change and on a ~25 s heartbeat. On unmount / map switch, fire the
`sendBeacon` leave.

### 4.2 Presence store (ephemeral, separate from mapStore)
A small store — `Map<characterId, Entry>` for the active map. The
`useMapEventStream` hook dispatches the new events to it:
- `presence.snapshot` → replace roster.
- `presence.update` → upsert (skip our **own** characterId — the existing
  "you are here" indicator covers self).
- `presence.leave` → remove.
- Reset the store on map switch.

These are **not** routed through `mapStore.applyRemote` — presence is transient
UI state, not map data.

### 4.3 Rendering
Reuse the fleet-dot pattern: a `usePresence()` selector exposes
`Map<eveSystemId, viewers[]>`; `SystemNode` renders presence dots for its system,
in a **distinct colour from fleet** (e.g. teal vs purple), hover → character
name(s), co-located viewers stacked/counted.

- **On-map only**: a dot renders only when the viewer's `eveSystemId` matches a
  node on the map. Viewers elsewhere in New Eden (e.g. sitting in Jita) don't get
  a dot.
- **Off-map viewers (optional, v1.1)**: a small sidebar roster — "Viewing: 4
  (2 in chain, 2 elsewhere)" — for the ones whose system isn't a node.

## 5. Privacy / scope
- Opt-in via the existing location-tracking toggle; off → you see others, don't
  broadcast.
- Room-scoped + access-checked → only people who can see the map.
- Ephemeral — nothing written to the DB; in-memory, expires on disconnect/TTL.

## 6. Phased rollout
1. **Server**: `presence.ts` (registry + report/remove/snapshot + TTL sweep),
   the POST/DELETE endpoints, snapshot on SSE connect, clear on disconnect.
2. **Client**: report-own-location (heartbeat + on-change + leave beacon),
   presence store, dispatch the three events, render on-map dots (distinct
   colour, self-suppressed, co-located stacking).
3. **(Optional)** off-map "viewing" roster in the sidebar.
4. **(Later, if scaling)** move the roster fan-out behind Postgres
   `LISTEN/NOTIFY`, same as the edit stream.

## 7. Notes / risks
- **No extra ESI load**: each user already polls their own location; presence
  just reports the result. It unlocks a capability polling can't (seeing others),
  not an optimization.
- **Heartbeat cadence**: ~25 s report + ~60 s TTL keeps the roster fresh without
  chatter; location itself is ESI-cached ~5 s so dots track jumps closely.
- **Fleet stays**: presence is additive; a viewer who's also a fleet member may
  show both a fleet and a presence dot — fine, or dedupe later.
- **Single instance** assumption, identical to the SSE edit stream.
