# Nexum

A wormhole mapping tool for EVE Online. Track systems, signatures, structures, kills, and live activity data across your chain.

---

## Overview

### Key features

#### Mapping

- **Interactive map** — drag systems, draw connections, set wormhole class/type/status per connection. Snap-to-grid, optional minimap.
- **Wormhole intel** — per-connection mass tracker (≤10% / ≤50% / critical), end-of-life flag with countdown, K162-aware static identification, frig-hole and gas-site auto-tagging from sig type.
- **Wormhole type picker** — searchable popover for assigning the exact wormhole type to a connection; statics quick-info on hover shows destination class, mass, lifetime.
- **Multi-select bulk operations** — shift-click to select multiple systems/signatures, then bulk-assign type, delete, or rename.
- **PNG export** — render the current map (with sig counts, connections, status) to a PNG for sharing.
- **Map PNG / clipboard** — copy or download the current chain as an image for pings.
- **Wormhole sig aging** — wormhole signatures tint by their position in the WH type's known lifetime (yellow ≥50%, orange ≥90%, red past expected close). K162s stay neutral since the lifetime isn't knowable from this side.

#### Personal & corp maps

- **Solo / Corp split** — every user has personal maps that are always private; in corp mode each corp also gets shared corp maps. Cross-corp visibility is opt-in via `CORP_MAP_SHARED` (see [Corp mode](#corp-mode)).
- **Multi-map support** — each character (or corp) can maintain multiple independent maps up to configured limits (`MAX_USER_MAPS` / `MAX_CORP_MAPS`).
- **Map locking** — admins can freeze a corp map's topology. Systems, connections, and the map name lock for non-admins, but signatures, structures, and per-system notes stay editable so ops can continue while the layout is pinned. The toolbar shows an amber 🔒 chip while the lock is active, and passive location tracking won't auto-add new systems on a locked map.
- **Role-based access** — `admin` / `full` / `edit` / `readonly`. Roles only restrict corp-map actions; every user owns their personal maps regardless of role. See [Roles](#roles) for the full matrix.

#### System intelligence

- **System panel** — per-system cards for signatures, structures, NPC stations, notes, killboard, and activity charts; cards are reorderable via drag-and-drop and persist per-user.
- **Signature management** — paste EVE scan results directly; tracks created/updated age per signature; auto-deletes sigs missing from a re-paste; bulk type assignment for multi-select.
- **Structure import** — paste EVE overview data to import player-owned structures.
- **Auto-discovered structures** — citadels you own (via ESI, if the logged-in character has the Station Manager / Director role) and publicly-listed structures (via `PUBLIC_STRUCTURES_URL`) appear automatically in the structures pane as read-only entries with `Corp` / `Public` badges. Standings tints apply the same as manual entries. Corp-ESI rows are scoped per-corp; public-dataset rows are visible to everyone. See [Auto-discovered structures](#auto-discovered-structures).
- **Activity charts** — 24-hour rolling history of jumps, ship/pod kills, and NPC kills, polled hourly from ESI. The poller persists **every k-space system** (not just ones a Nexum user has opened), so chart data accumulates cluster-wide and survives server restarts.
- **Sovereignty & station data** — live alliance/corp/faction sov info and NPC station services with in-game waypoint/destination actions.
- **Killboard pane** — recent zKillboard activity per system; recent kills also bubble up as highlights on the map. NPC-only kills (CONCORD, rats, etc.) are hidden by default with a toggle to include them.
- **Standings overlay** — your EVE contact list (personal, corp, and alliance — fetched via ESI on login and re-pullable on demand from the sov header) drives a chain-wide visual layer. Sov holders show inline P/C/A pills with EVE-palette colour tiers; killboard rows tint red when a hostile actor is in the chain or a blue gets killed, blue when a friendly scores or a hostile dies; structures resolved via ESI tint by their owner corp's standing; sov-holder systems on the map gain a coloured halo. Nothing is sent off-instance — all logic runs against your own contacts.
- **Chain effect summary** — at-a-glance view of all wormhole effects currently present in the chain.

#### Live ops

- **Scout connections** — Thera and Turnur public Eve-Scout connections surfaced into the sidebar so you can jump straight to known holes.
- **A0 sun detection** — auto-flags systems with A0 (yellow) suns visible via ESI for capital-friendly skirmish planning.
- **Proximity alerts** — incursions, pirate insurgencies, **and hostile-sov-holder systems** (any sov-holding system where you've set the corp or alliance to a negative standing) appear as a toolbar chip showing the closest threat in jumps. Configurable threshold with browser notification + audio ping when you cross into the zone.
- **Route planner** — server-side BFS over stargates + your live chain, so a route through a wormhole hop is a single click.
- **Location tracking** — opt-in live character location dot in the toolbar plus per-map "you are here" indicator.
- **Online status** — toolbar dot shows whether each user is currently logged into EVE Online.

#### Productivity & UX

- **Command palette** — `Cmd/Ctrl + K` opens a fuzzy search across systems, sigs, and actions (jump to system, set waypoint, toggle panes).
- **Home hotkey** — jump the viewport back to the home system from any panel.
- **Recent-kill highlights** — systems with kills in the last hour get a coloured halo so you can see fresh activity at a glance.
- **User stats modal** — per-character totals: jumps, signatures by type, broken down by day/week/month/year/forever.
- **Server status widget** — live Tranquility server status, player count, and ESI health in the toolbar.
- **Demo map** — the landing page mounts a non-editable demo map so visitors can see what the tool does before logging in.
- **Collapsible sidebar** — Map Options, Connections, Proximity Alerts, Stale System Fade, and Shortcuts each expand or collapse independently. Per-section open/closed state persists per browser via `localStorage`.
- **European date format** — DD-MM-YYYY everywhere a date is displayed (chart axes, relative-time fallbacks for events older than a month). ISO timestamps are still used in CSV exports for spreadsheet sortability.

#### For corporations

These features only matter once `CORP_ID` is set — see [Corp mode](#corp-mode) for the full configuration.

- **Multi-corp deployments** — `CORP_ID` accepts a comma-separated list of corporation IDs. One Nexum instance can host several corps; each corp's maps stay scoped to its own members unless `CORP_MAP_SHARED=true`.
- **Admin dashboard** — a dedicated `#/admin` page with four tabs: Users, Maps, Reports, Audit log. Admins reach it from the toolbar's Admin button.
- **User management** — change roles, block / unblock, and force an ESI corp-membership re-check on demand. Self-block / self-demote and changes to `ADMIN_CHAR_ID` are guarded against. Anyone who has left every listed corp is auto-blocked on the next login or recheck.
- **Map management** — admins see every corp map (solo maps are excluded by design) with owner avatar, corp ticker, system / connection counts, lock state, and last-active time. Force-lock, force-unlock, and force-delete are one-click each.
- **Users report** — per-character last-login, systems added / deleted, structures added, signatures broken down by type, and last-corp-activity timestamps. Every column sortable, filterable by activity (logins / signatures / structures) and time window (24h / week / month / year / all), exportable as CSV.
- **Systems report** — aggregate corp-map signatures with a sig-type donut, daily / monthly activity line chart (bucketing adapts to the window), and a sortable wormhole-type breakdown.
- **Audit log** — every admin action (role change, block, force-lock, force-unlock, force-delete, ESI corp change, auto-block on departure) is recorded with actor, target, old → new value, and timestamp. Exportable as CSV.
- **Corp ticker resolution** — corp IDs in the Users and Maps reports are resolved to in-game tickers via ESI (`/v5/corporations/{id}/`), with a 1-hour in-memory cache to keep the report loads cheap.
- **Per-character attribution** — sigs, structures, and system add / delete actions are recorded with the user who made them, so reports can answer "who has been scanning what" with no manual logging.

## Installation

### Option 1 — Docker (recommended)

**Prerequisites:** Docker with Compose, an EVE Online developer application ([developers.eveonline.com](https://developers.eveonline.com)).

**1. Clone and configure**

```bash
git clone https://github.com/GQuantrill/eve-nexum.git
cd eve-nexum
cp .env.example .env
```

Edit `.env` and fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `PG_PASSWORD` | Yes | PostgreSQL password |
| `SESSION_SECRET` | Yes | Random secret — run `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | Yes (production) | 64 hex chars used to encrypt stored EVE OAuth tokens at rest — run `openssl rand -hex 32`. **Do not change after first boot** — rotating this key makes existing stored tokens unreadable and forces every user to re-login. In development the key is auto-derived from `SESSION_SECRET` if unset. |
| `EVE_CLIENT_ID` | Yes | From your EVE developer app |
| `EVE_CLIENT_SECRET` | Yes | From your EVE developer app |
| `EVE_CALLBACK_URL` | Yes | Must match the callback registered in your EVE app — e.g. `https://yourdomain.com/auth/callback` |
| `FRONTEND_URL` | Yes | Public URL of the app — e.g. `https://yourdomain.com` |
| `DOMAIN` | Traefik only | Bare hostname for the Traefik router rule — e.g. `nexum.yourdomain.com` |
| `CORP_ID` | Optional | Restricts logins to specific EVE corporations. **Comma-separated list** of corporation IDs — anyone whose corp is not in the list is rejected at the OAuth callback. Leave empty/unset to allow any EVE character to log in. Example single corp: `98000001`. Example multi-corp: `98000001,98000002`. |
| `ADMIN_CHAR_ID` | When `CORP_ID` is set | EVE character ID of the bootstrap admin. Forced to the `admin` role on first login and cannot be demoted or blocked by other admins. **Not a corp-membership exemption** — this character still has to be in one of the corps listed in `CORP_ID` to log in. See [What happens when a user leaves the corp](#what-happens-when-a-user-leaves-the-corp). |
| `CORP_MAP_SHARED` | Optional | `1` / `true` to share every corp map across every listed corp. Default (`false`) scopes corp maps to the corp that created them — Corp A's chain stays invisible to Corp B even when they share a deployment. Only enable when all listed corps explicitly trust each other. |
| `CORP_MAP_TIME` | Optional | Days an idle corp map can sit untouched before it's auto-archived. Default `30`. |
| `MAX_USER_MAPS` | Optional | Max number of personal maps per user. Default `5`. |
| `MAX_CORP_MAPS` | Optional | Max number of corp maps per corp. Default `5`. |
| `PUBLIC_STRUCTURES_URL` | Optional | HTTP(S) URL to a JSON feed of public structures (citadels, refineries, etc.) for the "auto-discovered structures" feature. Imported daily into `known_structures`. Leave unset to disable the public-dataset path. See [Auto-discovered structures](#auto-discovered-structures) for the expected format. |

**EVE developer app scopes**

When registering your application at [developers.eveonline.com](https://developers.eveonline.com), enable the following scopes:

| Scope | Purpose |
|---|---|
| `esi-location.read_location.v1` | Read character's current solar system |
| `esi-location.read_ship_type.v1` | Read character's active ship |
| `esi-location.read_online.v1` | Read character online status |
| `esi-ui.open_window.v1` | Open windows in the EVE client |
| `esi-ui.write_waypoint.v1` | Set destinations and add waypoints |
| `esi-universe.read_structures.v1` | Read player-owned structure info |
| `esi-corporations.read_corporation_membership.v1` | Read corporation member list |
| `esi-characters.read_corporation_roles.v1` | Read character's corporation roles |
| `esi-characters.read_contacts.v1` | Read the character's personal contact list (standings) — used to colour-tag hostile / friendly entities in the Standings card, Killboard, Sov holder, and map node halos. |
| `esi-corporations.read_contacts.v1` | Read the **corporation's** shared contact list. Only succeeds for characters with the in-game **Contact Manager** role; the call is gracefully skipped for anyone else. When it does succeed, the entire corp benefits from the pulled standings until the next refresh. |
| `esi-alliances.read_contacts.v1` | Read the **alliance's** shared contact list. Requires the character to be in the alliance executor corp with the right role; almost always denied for normal members, and that's fine — the call no-ops without breaking login. |
| `esi-corporations.read_structures.v1` | Read the **corporation's** owned structures (citadels, refineries, etc.). Requires the in-game **Station Manager** or **Director** role. When granted, structures auto-populate per system in the structures pane; when denied (the common case), the call no-ops silently. |

**2. Build and start**

**Standard (direct ports):**
```bash
docker compose up -d --build
```
The app will be available on port `80`.

**With Traefik reverse proxy:**

Add `DOMAIN=nexum.yourdomain.com` to your `.env`, then:
```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```
Traefik will handle TLS termination and HTTP→HTTPS redirects. The `docker-compose.traefik.yml` overlay assumes a Traefik network named `traefik-public` and a cert resolver named `letsencrypt`.

**3. Database setup**

Application tables (`users`, `maps`, `signatures`, etc.) are created automatically on first startup — no manual step needed.

The setup script is only required if you want system search and NPC station data (it imports the EVE Static Data Export). This is a one-time operation and takes several minutes:

```bash
# Standard
docker compose exec server node dist/scripts/setup-db.js

# With Traefik overlay
docker compose -f docker-compose.yml -f docker-compose.traefik.yml exec server node dist/scripts/setup-db.js
```

---

### Option 2 — Local development

**Prerequisites:** Node.js 20+, Yarn, PostgreSQL 16.

**1. Clone and configure**

```bash
git clone https://github.com/GQuantrill/eve-nexum.git
cd eve-nexum
cp .env.example .env
```

Set `NODE_ENV=development` and point `PG_HOST=localhost` in your `.env`.

**2. Install dependencies**

```bash
cd server && yarn install
cd ../web   && yarn install
```

**3. Start the server**

```bash
cd server
yarn dev
```

**4. Start the frontend**

```bash
cd web
yarn dev
```

The frontend is available at `http://localhost:5174`. The Vite dev server proxies `/api` and `/auth` to `http://localhost:3001`.

---

## Static data files

Some pre-computed lookups live in `server/data/` as plain JSON, derived once from the EVE Static Data Export (SDE). They're committed to the repo so a fresh install works without an extra step. You only need to regenerate them when CCP releases an SDE drop that adds or changes the underlying data.

### `data/a0-systems.json`

List of solar system IDs whose star is the visual "Sun A0 (Blue Small)" type (`typeID 3801` in the SDE). The server reads it at startup and exposes the list via `GET /api/systems/a0`; the client uses it to render a `★` icon on the matching system nodes. Currently 245 entries spanning both K-space and J-space.

> Note: this is the canonical in-game "A0" classification (`typeID 3801`), not the SDE's `statistics.spectralClass` field. The two don't agree — a "Sun A0 (Blue Small)" system can carry a `spectralClass` value like `"F8 V"`. The `typeID` is what players actually see in-game and what other A0 tools filter on.

To regenerate from the SDE zip in `server/data/`:

```bash
cd server
unzip -p data/eve-online-static-data-*-jsonl.zip mapStars.jsonl | node -e "
const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
const ids = [];
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    if (o.typeID === 3801) ids.push(o.solarSystemID);
  } catch {}
}
ids.sort((a, b) => a - b);
require('fs').writeFileSync('data/a0-systems.json', JSON.stringify(ids) + '\n');
console.log('wrote ' + ids.length + ' A0 system IDs');
"
```

Restart the server after regenerating — the file is read once at process start.

---

## Corp mode

When `CORP_ID` is set, Nexum operates in **corp mode** — only members of the listed corporations can log in. All four user roles described below apply only in corp mode; open deployments (no `CORP_ID`) treat every authenticated character as a normal user with full access to their own maps.

### Allowing multiple corporations

`CORP_ID` accepts a comma-separated list of corporation IDs. Every character logging in is checked against this list via ESI; anyone whose corp is not included is bounced to the landing page with `?error=not_in_corp`.

```dotenv
# Single corp
CORP_ID=98000001

# Two (or more) corps sharing the same deployment
CORP_ID=98000001,98000002,98000003
```

### How corp map visibility works

By default (`CORP_MAP_SHARED=false`), **corp maps are scoped to the corp that created them**. If Corp A creates a corp map, only members of Corp A can see it — Corp B's members never know it exists, even though they share the deployment. This is the safer default for alliance-shared instances where each corp wants to keep its chain intel private.

Set `CORP_MAP_SHARED=true` to make every corp map visible to every listed corp. Only do this when all listed corps explicitly trust each other.

Personal maps are **always private to their owning user**, regardless of corp or `CORP_MAP_SHARED`. Leaving a corp does not transfer ownership.

### Roles

Roles are stored per-user in the database. New users default to `readonly`; an admin must promote them.

Rules differ for personal (solo) maps vs corp maps. Personal maps are scoped to a single user; corp maps are shared infrastructure and gated more tightly.

**Personal maps** — every user can create their own personal maps (up to `MAX_USER_MAPS`) and edit everything inside them, regardless of role. A `readonly` user is "readonly" only with respect to other people's maps; their own personal map is theirs.

**Corp maps:**

| Role       | View | Edit signatures / structures / notes | Edit systems / connections / rename | Create / delete corp map | Lock map | Manage users |
|---|---|---|---|---|---|---|
| `readonly` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `edit`     | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `full`     | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| `admin`    | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The character whose ID matches `ADMIN_CHAR_ID` is always given `admin` on login and **cannot be demoted or blocked** by other admins. Leave it set even after you've promoted other admins — it's the recovery path against an admin demoting themselves or being blocked by mistake.

### Map locking

Admins can lock any corp map from the **Admin → Maps** page. A locked map keeps accepting **signatures, structures, and per-system notes** from any user with normal edit permission, but rejects topology mutations — system add/move/remove, connection add/edit/delete, and map rename are all frozen for non-admins. The toolbar shows an amber 🔒 Locked chip next to the map name while the lock is active.

A locked map also stops auto-growing from passive location tracking: even an admin walking through EVE won't sprout new systems on a locked chain (admins can still add manually via the canvas right-click). This is intentional — locking is what you do when you want the layout pinned, including against your own movements.

`force_lock_map` and `force_unlock_map` actions are written to the audit log.

### What happens when a user leaves the corp

The corp membership check runs **at login**. Existing sessions keep working until the user logs out and back in — at which point ESI is queried again and a corp departure causes the login to fail. Admins can also manually block a user (see below), which prevents login entirely regardless of corp membership.

#### …including `ADMIN_CHAR_ID`

The corp gate is fail-closed and **does not exempt `ADMIN_CHAR_ID`**. If your bootstrap admin character leaves every corp listed in `CORP_ID`, their next login is rejected just like anyone else's, and because they can no longer log in there's no in-app path to recover. This is intentional — a former member walking out of corp with admin keys is exactly who you *don't* want signing back in. To recover you have three options:

1. Move the character back into one of the listed corps in-game and log in again.
2. Edit `.env` to add their new corp to `CORP_ID` and restart the server.
3. Edit the `users` table directly (last resort).

If you want a permanent break-glass, run a second `ADMIN_CHAR_ID`-eligible character in a corp you control and don't plan to leave.

### Admin operations

Admins reach the dashboard from the **Admin** button in the toolbar, which lands them at `#/admin/users`. The page has four tabs:

- **Users** — role select, block / unblock, recheck corp via ESI.
- **Maps** — every corp map across every listed corp. Force-lock, force-unlock, force-delete. Solo maps are deliberately excluded — they belong to individual users.
- **Reports** — placeholder for future ops reports.
- **Audit log** — last 200 admin actions, newest first.

Each tab is also reachable at its own hash route (`#/admin/maps`, `#/admin/audit`, …). All mutating actions write to the `admin_audit` table with the actor, target, old value, and new value.

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/users` | Full user list with role, corp ID (and resolved corp ticker from ESI), blocked status, last login, and activity counts. |
| `PATCH /api/admin/users/:id/role` | Change a user's role to one of `admin`, `full`, `edit`, `readonly`. Cannot demote yourself or the `ADMIN_CHAR_ID` character. |
| `POST /api/admin/users/:id/block` | Block a user from logging in. They keep their existing session until next login, then get bounced with `?error=blocked`. Cannot block yourself or `ADMIN_CHAR_ID`. |
| `POST /api/admin/users/:id/unblock` | Reverse a block. |
| `POST /api/admin/users/:id/recheck-corp` | Hits ESI for the target user's current corp without waiting for their next login. If they've left every corp in `CORP_ID`, they're auto-blocked. Useful when a known departure needs to take effect immediately. |
| `GET /api/admin/maps` | Every corp map with owner, corp ticker, system / connection counts, lock state, last active. |
| `POST /api/admin/maps/:id/lock` | Freeze a corp map's topology. Signatures/structures/notes remain editable; see [Map locking](#map-locking). |
| `POST /api/admin/maps/:id/unlock` | Reverse a lock. |
| `DELETE /api/admin/maps/:id` | Force-delete a corp map regardless of who owns it. |
| `GET /api/admin/audit` | The 200 most recent admin actions (role change, block, unblock, corp change, auto-block-on-departure, force-lock, force-unlock, force-delete). |

#### What admins **cannot** do

- Demote themselves (use another admin).
- Demote or block the character whose ID is in `ADMIN_CHAR_ID` — that character is the safety hatch.
- Force-terminate an existing live session. A blocked user stays signed in until they log out or their session cookie expires; the next login then fails. If you need someone offline *right now*, blocking + revoking their EVE OAuth in CCP's developer panel is the immediate path.

---

## Auto-discovered structures

The structures pane combines two sources of structure intel and shows them alongside the user's manual entries:

1. **Your corp's structures (via ESI).** Hourly, Nexum picks a logged-in member of each corp it knows about and calls `GET /v3/corporations/{corp_id}/structures/`. If that character has the in-game **Station Manager** or **Director** role, the call succeeds and every citadel / refinery / etc. the corp owns is upserted into the `known_structures` table. These rows are scoped to the owning corp (`restricted_to_corp_id`) so members of other corps sharing the same Nexum deployment never see them. If no logged-in member has the role, ESI returns 403 and the puller silently no-ops.

2. **Publicly-listed structures (via a third-party feed).** Set `PUBLIC_STRUCTURES_URL` to an HTTPS endpoint that returns JSON in either of these shapes and Nexum will fetch it daily, normalising and upserting into the same table with no corp-scope restriction.

**Accepted JSON formats:**

```jsonc
// Array form
[
  { "structure_id": 1027564925148, "system_id": 30000142, "owner_id": 98000001, "type_id": 35832, "name": "Jita - Wormholers Inc." },
  ...
]

// Object form (keyed by structure ID)
{
  "1027564925148": { "system_id": 30000142, "owner_id": 98000001, "type_id": 35832, "name": "..." },
  ...
}
```

Field aliases are accepted: `structureID` / `id` for `structure_id`, `systemID` / `solar_system_id` for `system_id`, `corp_id` for `owner_id`, `typeID` for `type_id`. Anything else is ignored.

**Where they appear in the UI:** the structures pane renders auto-discovered rows below your manual entries in a read-only "Auto-discovered" section with `Corp` / `Public` badges. Entries that already exist as manual rows (matched by `eve_id`) are not duplicated. Standings tints apply the same way as manual entries — hostile owners get red rows, friendlies get blue.

**Admin overrides:** admins can force-refresh from the Admin UI (or `POST /api/known-structures/refresh-corp` to re-pull this corp's ESI structures right now, and `POST /api/known-structures/import-public` with `{ "url": "..." }` to trigger an immediate dataset import).

**Precedence:** when a `corp-esi` row and a `public-dataset` row collide on the same `structure_id`, the corp-ESI row wins on every field — it's authoritative and fresher.

---

## Technology Overview

### Frontend — `web/`

| Technology | Role |
|---|---|
| [React 19](https://react.dev) + TypeScript | UI framework |
| [Vite](https://vitejs.dev) | Build tool and dev server |
| [Zustand](https://zustand-demo.pmnd.rs) | Client-side state (maps, selections, undo history) |
| [@xyflow/react](https://reactflow.dev) | Interactive node-graph canvas for the wormhole map |
| [@dnd-kit](https://dndkit.com) | Drag-and-drop reordering of system panel cards |
| [@uiw/react-md-editor](https://github.com/uiwjs/react-md-editor) | Markdown notes editor |

The frontend is a fully static SPA after build. In production it is served by nginx, which also proxies all `/api/*` and `/auth/*` requests to the API server.

### Backend — `server/`

| Technology | Role |
|---|---|
| [Node.js 20](https://nodejs.org) + TypeScript | Runtime |
| [Express](https://expressjs.com) | HTTP server and routing |
| [PostgreSQL 16](https://www.postgresql.org) via `pg` | Persistent storage for maps, systems, signatures, structures, sessions |
| `express-session` + `connect-pg-simple` | Session management with database-backed store |
| [EVE SSO (OAuth2)](https://developers.eveonline.com/blog/article/sso-to-authenticated-calls) | Character authentication |

### External APIs

| API | Data |
|---|---|
| [ESI](https://esi.evetech.net) | System info, sovereignty, NPC stations, jumps, kills, server status, character online status |
| [zKillboard](https://zkillboard.com) | Recent kill feed per system |
| [EVE Image Server](https://images.evetech.net) | Character portraits, alliance and corporation logos |

### Infrastructure

| Component | Technology |
|---|---|
| Web server | nginx (Alpine) |
| Container orchestration | Docker Compose |
| Database | PostgreSQL 16 (Alpine) |


