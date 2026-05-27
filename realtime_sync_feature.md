# Real-Time Map Sync — Design

## 1. Goal & scope

Propagate **map edits between users live**: when someone adds/moves a system,
draws a connection, pastes signatures, etc. on a map, everyone currently viewing
that map sees it without reloading. Today edits are optimistic locally and only
reach other viewers on their next `switchMap`/reload — fine for solo maps,
a real gap for **corp maps and shared maps** with concurrent editors (and for one
user with two tabs/devices open).

**In scope:** live propagation of map-content mutations (systems, connections,
signatures, structures, notes, lock/rename, merge).

**Out of scope (do not conflate):**
- The per-system ESI fetch volume — already addressed by serving static data
  from the DB; real-time doesn't touch it.
- The ESI-derived cluster feeds (scout connections, activity, killboard, online
  status, sov) — those stay on their existing polls for now.

## 2. Why SSE, not WebSockets/SignalR

Nexum's client→server path is already REST (optimistic mutate → PATCH/POST). We
only need **server→client push**. That's one-directional, so **Server-Sent
Events (SSE)** is the better fit than a full socket:

| | SSE (recommended) | WebSocket / Socket.IO |
|---|---|---|
| Direction | server→client only (all we need) | bidirectional |
| Auth | reuses the **session cookie** as-is | needs handshake wiring |
| Reconnect | **native** (`EventSource` auto-retries, `Last-Event-ID`) | manual / library |
| Deps | none (built into Node + browser) | new dependency |
| nginx | one `location` + `proxy_buffering off` | upgrade-header dance |
| Behind Traefik (HTTP/2) | multiplexed, no 6-connection limit | n/a |

Sextant uses SignalR because it's a .NET shop and wanted bidirectional; we get
the same UX with far less moving parts. If we ever need client→server over the
socket (we don't today), we can revisit. **Recommendation: SSE.**

## 3. Scoping — the key difference from Sextant

Sextant broadcasts every event to every connected client (single-corp deploy).
Nexum **must scope per map**, or Corp A sees Corp B's edits and every client gets
spammed with maps they aren't looking at.

- A client subscribes to **one map at a time** — the one it has open
  (`activeMapId`). On `switchMap`, it closes the old stream and opens the new.
- The subscribe endpoint is **access-checked with the existing `getMapAccess`**,
  so visibility (owner / corp_member / shared) is enforced exactly as elsewhere.
  Corp B literally can't subscribe to Corp A's map.
- Events for map X fan out only to subscribers of map X.

## 4. Server design

### 4.1 Subscribe endpoint (SSE)
`GET /api/maps/:mapId/events` (under `requireAuth` + `getMapAccess`):
- Sets `Content-Type: text/event-stream`, disables buffering, sends a heartbeat
  comment every ~25s (keeps proxies from closing idle streams).
- Registers the response in an in-memory registry: `Map<mapId, Set<res>>`.
- On `req.close`, removes it.

### 4.2 Publish helper
`publishToMap(mapId, event)` — writes `event: <type>\ndata: <json>\n\n` to every
`res` in that map's set. A module-level `services/mapEvents.ts` owns the registry
+ helper.

### 4.3 Firing events
Each mutating route, **after** it persists, calls `publishToMap(mapId, …)`. The
event payload mirrors the data the store already works with, plus an `actor`
field (the originating `clientId`, see §5). Event types map 1:1 to the store's
existing mutations:

| Route | Event |
|---|---|
| `POST /:mapId/systems` | `system.add` (the new system row) |
| `PATCH /:mapId/systems/:id` (incl. position) | `system.update` |
| `DELETE /:mapId/systems/:id` | `system.remove` |
| `POST /:mapId/connections` | `connection.add` |
| `PATCH/DELETE …/connections/:id` | `connection.update` / `connection.remove` |
| sig add/update/delete | `sig.*` |
| structure add/update/delete | `structure.*` |
| `PATCH /:mapId` (rename/lock) | `map.meta` |
| **merge** (touches many rows) | `map.resync` (coarse — clients refetch) |

> Big/bulk operations (merge, import) emit a single coarse `map.resync` rather
> than hundreds of deltas — clients just re-fetch the map.

### 4.4 Single-process note
The in-memory registry assumes **one server instance** (your current
docker-compose). If you ever run multiple replicas, swap the registry fan-out for
**Postgres `LISTEN/NOTIFY`** (you're already on PG): routes `NOTIFY map_events`,
each instance `LISTEN`s and fans out to its local SSE clients. Worth keeping the
`publishToMap` seam clean so this is a drop-in later.

## 5. Client design

### 5.1 Apply deltas via existing store reducers
The `mapStore` already has `addSystem` / `moveSystem` / `updateSystem` /
`removeSystem` / `addConnection` / `updateConnection` / `removeConnection`, used
for local edits (they mutate state **and** persist). Add a **remote apply path**
that runs the same state mutation but **skips persistence and undo** — a flag like
`{ remote: true }` (mirrors the existing `skipUndo`). So a `system.add` event ⇒
`applyRemote(addSystem, …)` ⇒ surgical store update ⇒ React Flow re-renders just
that node. **No full refetch, no flicker, selection/drag preserved.**

### 5.2 Subscription lifecycle
A small hook (e.g. `useMapEventStream`) opens an `EventSource` to
`/api/maps/${activeMapId}/events` when a map becomes active, closes it on switch/
unmount. `EventSource` handles reconnect automatically.

### 5.3 Echo suppression
The originating client already applied its own change optimistically. To avoid
re-applying its own echo: the client sends a stable per-tab `clientId` (header or
body) on every mutation; the server includes it in the event `actor`; the client
**ignores events whose `actor === myClientId`.** (Two tabs of the same user have
different `clientId`s, so they *do* sync to each other — correct.)

### 5.4 Resync on (re)connect — the safety net
On stream open **and** on every reconnect, the client does **one authoritative
`switchMap`/map fetch** to catch anything missed while disconnected. So: deltas
for the live path, full fetch as the correctness backstop. This makes missed/out-
of-order events self-heal.

## 6. Deployment

- **nginx** (`nginx.conf.template`): add a location for the event stream that
  disables buffering, e.g.
  ```
  location ~ ^/api/maps/.+/events$ {
      proxy_pass http://server:${API_PORT};
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Cookie $http_cookie;
      proxy_buffering off;
      proxy_read_timeout 1h;
  }
  ```
  (Place it **before** the generic `^/(api|auth)/` block so it wins.)
- **Traefik**: no change — SSE is just a long-lived HTTP response.
- **Server**: SSE works on the existing Express `http.Server`; no new port.

## 7. Phased rollout

1. ✅ **Plumbing** (done): `mapEvents.ts` registry + `publishToMap`, the SSE
   endpoint (access-checked), nginx location, the client `EventSource` hook with
   reconnect-resync. `system.add` wired end-to-end + echo suppression.
2. ✅ **Canvas mutations** (done): `system.update`/`remove`, `connection.add`/
   `update`/`remove`, `map.meta` (rename/lock) — applied surgically via
   `applyRemote`. Plus coarse **`map.resync`** for merge.
2b. ✅ **Signatures & structures** (done): coarse `sig.changed` / `structure.changed`
   events; the open pane re-fetches in place (invalidate, not delta — sig/struct
   live in pane state with bulk-paste logic, so a refetch is simpler and can't
   drift). Per-system `sigRev`/`structRev` counters in the store drive it.
4. ⬜ (Later, if scaling) Postgres `LISTEN/NOTIFY` behind `publishToMap`.

## 8. Risks / notes
- **Move spam**: dragging emits many `system.update`s. Server-side position
  saves are already debounced (~500ms), so events inherit that cadence — fine.
- **Solo maps**: still benefit (multi-tab/device); cost is one idle SSE stream.
- **Graceful degradation**: if the stream fails entirely, the app behaves exactly
  as today (optimistic local + load-on-switch). Real-time is purely additive.
