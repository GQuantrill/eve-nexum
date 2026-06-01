# Nexum

**Nexum is a free, open-source, self-hosted wormhole mapping tool for EVE Online — an alternative to [Pathfinder](https://github.com/exodus4d/pathfinder) and Tripwire.** Track systems, signatures, structures, kills, and live activity across your chain; calculate wormhole rolls; and coordinate your corporation in J-space in real time. Logs in with EVE Online SSO and runs anywhere Docker does.

> **Live demo:** [eve-nexum.com](https://eve-nexum.com) — a read-only demo map is viewable without logging in.
>
> **Compare:** [Nexum vs Pathfinder vs Tripwire vs Wanderer →](https://eve-nexum.com/compare/)

---

## Contents

- [Quick start](#quick-start)
- [Features](#features)
  - [Mapping](#mapping)
  - [Personal & corp maps](#personal--corp-maps)
  - [System intelligence](#system-intelligence)
  - [Live ops](#live-ops)
  - [Productivity & UX](#productivity--ux)
  - [For corporations](#for-corporations)
- [Installation](#installation)
  - [Docker (recommended)](#option-1--docker-recommended)
  - [Local development](#option-2--local-development)
  - [EVE developer app scopes](#eve-developer-app-scopes)
  - [Updating the SDE](#updating-the-sde)
  - [Refreshing wormhole types](#refreshing-wormhole-types)
  - [Upgrading an existing deployment](#upgrading-an-existing-deployment)
- [Corp mode](#corp-mode)
  - [Allowing multiple corporations](#allowing-multiple-corporations)
  - [How corp map visibility works](#how-corp-map-visibility-works)
  - [Roles](#roles)
  - [Map locking](#map-locking)
  - [Merging maps](#merging-maps)
  - [What happens when a user leaves the corp](#what-happens-when-a-user-leaves-the-corp)
  - [Discord notifications](#discord-notifications)
  - [Admin operations](#admin-operations)
- [Static data files](#static-data-files)
- [Technology overview](#technology-overview)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Quick start

Get a local Nexum running in about ten minutes. You'll need:

- **Docker** with Compose.
- **An EVE Online developer application** — register at [developers.eveonline.com](https://developers.eveonline.com) (free, ~2 minutes). Use `http://localhost/auth/callback` as the callback URL and enable the scopes listed in [EVE developer app scopes](#eve-developer-app-scopes).

Clone and configure:

```bash
git clone https://github.com/GQuantrill/eve-nexum.git
cd eve-nexum
cp .env.example .env
```

Open `.env` and set, at minimum:

```dotenv
EVE_CLIENT_ID=…           # from your EVE developer app
EVE_CLIENT_SECRET=…       # from your EVE developer app
EVE_CALLBACK_URL=http://localhost/auth/callback
FRONTEND_URL=http://localhost
PG_PASSWORD=…             # any strong password

# Generate each with `openssl rand -hex 32` and paste the result:
SESSION_SECRET=…
TOKEN_ENCRYPTION_KEY=…
```

Leave `CORP_ID` unset for now — that opens login to any EVE character. To restrict to one or more corps later, see [Corp mode](#corp-mode).

Build and start the stack. On first run an `importer` service downloads the EVE Static Data Export and populates Postgres (a one-off, a few minutes) before the server boots; later runs detect the data is already there and skip straight through:

```bash
docker compose build
docker compose up -d
```

Open <http://localhost> and click **Log in with EVE Online**. That's it.

**Next steps**

- Restrict logins to your corp, set up roles, locking, merges, or Discord notifications → [Corp mode](#corp-mode).
- Production deployment (TLS via Traefik, a public URL, periodic SDE refreshes, upgrades) → [Installation](#installation).
- Something not coming up → [Troubleshooting](#troubleshooting).

---

## Features

### Mapping

- **Interactive map** — drag systems, draw connections, set wormhole class/type/status per connection. Snap-to-grid, optional minimap.
- **Seed a map from a region** — when creating a map you can optionally pick an EVE region (searchable). The new map is pre-populated with every system in that region, laid out from CCP's 2D star-map projection (a Dotlan-style layout where stargate-connected systems sit adjacent), with all in-region stargate connections pre-drawn. Leave the region blank for an empty map. Requires solar-system coordinates in the SDE tables — see [Installation](#installation).
- **Wormhole intel** — per-connection mass status (stable / destabilized / critical), end-of-life flag with countdown, K162-aware static identification, frig-hole and gas-site auto-tagging from sig type.
- **Rolling calculator** — plan and track collapsing a hole from its connection panel. It models the ±10% wormhole mass variance, so every call is made against the worst case: a hatched band marks the uncertain-collapse zone and each pass button is colour-forecast safe / may-collapse / will-collapse. Define a roller ship (cold + prop-on mass, or pull your currently-flown ship from ESI), then click each pass to step through — it tracks which side the roller is on, warns loudly when a risky pass would strand it on the far side, and asks to confirm a pass that would collapse the hole. Shows an "≈ N more passes" estimate with undo/reset, and the cumulative mass syncs live to everyone viewing the hole.
- **Wormhole type picker** — searchable popover for assigning the exact wormhole type to a connection; statics quick-info on hover shows destination class, mass, lifetime.
- **Multi-select bulk operations** — shift-click to select multiple systems/signatures, then bulk-assign type, delete, or rename.
- **PNG export** — render the current map (with sig counts, connections, status) to a PNG for sharing.
- **Map PNG / clipboard** — copy or download the current chain as an image for pings.
- **Wormhole sig aging** — wormhole signatures tint by their position in the WH type's known lifetime (yellow ≥50%, orange ≥90%, red past expected close). K162s stay neutral since the lifetime isn't knowable from this side.

### Personal & corp maps

- **Solo / Corp split** — every user has personal maps that are always private; in corp mode each corp also gets shared corp maps. Cross-corp visibility is opt-in via `CORP_MAP_SHARED` (see [Corp mode](#corp-mode)).
- **Multi-character accounts** — link several characters (alts) to a single account and switch the active character from the in-app switcher with no re-login, since each character's token is already stored. Linking merges that character's maps onto the account; the per-account map cap is enforced only at creation, so nothing is lost on link. You can also follow an alt's live (or last-known) location and route from it while flying your main, and unlink a character at any time — an unlinked character keeps its own data and becomes a standalone account again on its next login. The currently-active character can't be removed (switch away first).
- **Share a personal map with another character or corp** — owners can grant edit access to a specific EVE character or an entire corp from the map sidebar. Recipients can edit signatures, structures, notes, and topology like a corp member but can't rename, delete, or re-share the map. Grants target raw EVE IDs, so they take effect on the recipient's very first Nexum login — no pre-registration required. The map appears in their switcher under a distinct "Shared" badge. Personal maps only; corp maps are already shared via membership.
- **Multi-map support** — each character (or corp) can maintain multiple independent maps up to configured limits (`MAX_USER_MAPS` / `MAX_CORP_MAPS`).
- **Real-time collaboration** — edits propagate live to everyone viewing the same map. Adding/moving/removing systems, drawing or retyping connections, renaming or locking the map, signature and structure changes, and merges all appear for other viewers within moments — no refresh. Delivered over a per-map Server-Sent Events stream (access-checked, so you only ever receive events for maps you can see), with your own changes echo-suppressed and an automatic resync on reconnect. Purely additive: if the stream drops, editing still works exactly as before.
- **Merge maps** — fold one map's contents into another. The destination is the source of truth: existing systems are kept and only missing systems and connections are added, while signatures, structures, and notes are merged in (each toggleable in the merge dialog). New systems are aligned into the destination's existing layout near the systems they connect to, rather than dumped off to one side. Corp maps must be explicitly opted in — separately as a merge **source** and/or **destination** — and any merge touching a corp map is recorded in the audit log. See [Merging maps](#merging-maps) for the roles involved.
- **Map locking** — admins can freeze a corp map's topology. Systems, connections, and the map name lock for non-admins, but signatures, structures, and per-system notes stay editable so ops can continue while the layout is pinned. The toolbar shows an amber 🔒 chip while the lock is active, and passive location tracking won't auto-add new systems on a locked map.
- **Role-based access** — `admin` / `full` / `edit` / `readonly`. Roles only restrict corp-map actions; every user owns their personal maps regardless of role. See [Roles](#roles) for the full matrix.

### System intelligence

- **System panel** — per-system cards for signatures, structures, NPC stations, notes, killboard, and activity charts; cards are reorderable via drag-and-drop and persist per-user.
- **Signature management** — paste EVE scan results directly; tracks created/updated age per signature; auto-deletes sigs missing from a re-paste; bulk type assignment for multi-select.
- **Structure import** — paste EVE overview data to import player-owned structures.
- **Activity charts** — 24-hour rolling history of jumps, ship/pod kills, and NPC kills, polled hourly from ESI. The poller persists **every k-space system** (not just ones a Nexum user has opened), so chart data accumulates cluster-wide and survives server restarts.
- **Sovereignty & station data** — live alliance/corp/faction sov info and NPC station services with in-game waypoint/destination actions.
- **Killboard pane** — recent zKillboard activity per system; recent kills also bubble up as highlights on the map. NPC-only kills (CONCORD, rats, etc.) are hidden by default with a toggle to include them.
- **Standings overlay** — your EVE contact list (personal, corp, and alliance — fetched via ESI on login and re-pullable on demand from the sov header) drives a chain-wide visual layer. Sov holders show inline P/C/A pills with EVE-palette colour tiers; killboard rows tint red when a hostile actor is in the chain or a blue gets killed, blue when a friendly scores or a hostile dies; structures resolved via ESI tint by their owner corp's standing; sov-holder systems on the map gain a coloured halo. Nothing is sent off-instance — all logic runs against your own contacts.
- **Chain effect summary** — at-a-glance view of all wormhole effects currently present in the chain.

### Live ops

- **Scout connections** — Thera and Turnur public Eve-Scout connections surfaced into the sidebar so you can jump straight to known holes.
- **A0 sun detection** — auto-flags systems with A0 (yellow) suns visible via ESI for capital-friendly skirmish planning.
- **Ice belt systems** — Empire-space systems that spawn ice anomalies get a ❄ icon. Static list in `server/data/ice-belt-systems.json` (sourced from the EVE University wiki), resolved to `eve_system_id` at startup against the SDE. Null-sec ice tracking will come later via the scraped respawn feed.
- **Storm tracking** — active null-sec storms (Electric / Gamma / Exotic / Plasma) from the community-maintained [EveScout Rescue stormtrack](https://evescoutrescue.com/home/stormtrack.php) feed surface as a colour-coded ⚡ icon on matching system nodes, with a tooltip showing last report and reporter. Refreshed every 30 minutes. (ESI doesn't expose stellar phenomena yet; this scrapes the public community feed and will swap to ESI when CCP ships one.)
- **Proximity alerts** — incursions, pirate insurgencies, **and hostile-sov-holder systems** (any sov-holding system where you've set the corp or alliance to a negative standing) appear as a toolbar chip showing the closest threat in jumps. Configurable threshold with browser notification + audio ping when you cross into the zone.
- **Inbound K162 alert** — when a signature's wormhole type is set to K162 anywhere on the map, a toast + browser notification + distinct audio ping fire immediately. K162 means "the other side opened this hole", so it's a strong intel signal that something just connected into your chain.
- **Discord notifications** — push corp chain intel to a Discord channel so alerts land even when nobody's watching the tab. Fires server-side on an inbound K162 and on a new wormhole connection, scoped to corp maps and configured per corp via a webhook URL (`DISCORD_WEBHOOK_URL`). Admins can narrow which regions and maps notify from the **Discord** tab in the admin panel. Best-effort and rate-limit-aware; bulk operations like region seeding never spam the channel. See [Discord notifications](#discord-notifications).
- **Chain exit summary** — sidebar widget that counts every K-space exit currently on the map by security class (HS / LS / NS) as coloured chips, and pinpoints the nearest gate route to Jita ("Nearest Jita: 7j via Amarr") so loot runs and logistics planning don't need a manual route check.
- **Route planner** — server-side BFS over stargates + your live chain, so a route through a wormhole hop is a single click.
- **Location tracking** — opt-in live character location dot in the toolbar plus per-map "you are here" indicator.
- **Pilot presence** — see where everyone *viewing the same map* is right now: a blue dot (pilot name on hover) marks each other viewer's current system, live as they jump. Unlike fleet dots it covers anyone with the map open, not just your fleet. Opt-in via location sharing, scoped to maps you can see, and ephemeral (nothing stored).
- **Online status** — toolbar dot shows whether each user is currently logged into EVE Online.

### Productivity & UX

- **Command palette** — `Cmd/Ctrl + K` opens a fuzzy search across systems, sigs, and actions (jump to system, set waypoint, toggle panes).
- **Home hotkey** — jump the viewport back to the home system from any panel.
- **Recent-kill highlights** — systems with kills in the last hour get a coloured halo so you can see fresh activity at a glance.
- **User stats modal** — per-character totals: jumps, signatures by type, broken down by day/week/month/year/forever, plus a 30-day daily sparkline of scanning activity with hover tooltips.
- **Server status widget** — live Tranquility server status, player count, and ESI health in the toolbar.
- **Demo map** — the landing page mounts a non-editable demo map so visitors can see what the tool does before logging in.
- **Collapsible sidebar** — Map Options, Connections, Proximity Alerts, Stale System Fade, and Shortcuts each expand or collapse independently. Per-section open/closed state persists per browser via `localStorage`.
- **European date format** — DD-MM-YYYY everywhere a date is displayed (chart axes, relative-time fallbacks for events older than a month). ISO timestamps are still used in CSV exports for spreadsheet sortability.
- **Multi-lingual** — the entire UI is translated into nine languages: English, Deutsch, Français, Español, Português, 简体中文, 한국어, 日本語, and Русский. The language is auto-detected from the browser (regional locales like `es-MX` or `en-GB` map to the base language) and can be changed any time from the in-app language switcher; the choice persists per browser. The public landing and comparison pages are localised too.

### For corporations

These features only matter once `CORP_ID` is set — see [Corp mode](#corp-mode) for the full configuration.

- **Multi-corp deployments** — `CORP_ID` accepts a comma-separated list of corporation IDs. One Nexum instance can host several corps; each corp's maps stay scoped to its own members unless `CORP_MAP_SHARED=true`.
- **Admin dashboard** — a dedicated `#/admin` page with five tabs: Users, Maps, Reports, Discord, Audit log. Admins reach it from the toolbar's Admin button.
- **User management** — change roles, block / unblock, and force an ESI corp-membership re-check on demand. Self-block / self-demote and changes to `ADMIN_CHAR_ID` are guarded against. Anyone who has left every listed corp is auto-blocked on the next login or recheck.
- **Map management** — admins see every corp map (solo maps are excluded by design) with owner avatar, corp ticker, system / connection counts, lock state, and last-active time. Force-lock, force-unlock, and force-delete are one-click each.
- **Users report** — per-character last-login, systems added / deleted, structures added, signatures broken down by type, and last-corp-activity timestamps. Every column sortable, filterable by activity (logins / signatures / structures) and time window (24h / week / month / year / all), exportable as CSV.
- **Systems report** — aggregate corp-map signatures with a sig-type donut, daily / monthly activity line chart (bucketing adapts to the window), and a sortable wormhole-type breakdown.
- **Audit log** — every admin action (role change, block, force-lock, force-unlock, force-delete, ESI corp change, auto-block on departure, corp-map merge as source/destination) is recorded with actor, target, old → new value, and timestamp. Exportable as CSV.
- **Corp ticker resolution** — corp IDs in the Users and Maps reports are resolved to in-game tickers via ESI (`/v5/corporations/{id}/`), with a 1-hour in-memory cache to keep the report loads cheap.
- **Per-character attribution** — sigs, structures, and system add / delete actions are recorded with the user who made them, so reports can answer "who has been scanning what" with no manual logging.

---

## Installation

### Option 1 — Docker (recommended)

**Prerequisites:** Docker with Compose, an EVE Online developer application ([developers.eveonline.com](https://developers.eveonline.com)).

**1. Clone and configure**

```bash
git clone https://codeberg.org/GQuantrill/eve-nexum.git
cd eve-nexum
cp .env.example .env
```

Edit `.env` and fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `PG_PASSWORD` | Yes | PostgreSQL password |
| `NODE_ENV` | Optional | Set to `development` for local dev (auto-derives `TOKEN_ENCRYPTION_KEY` from `SESSION_SECRET` and relaxes session-cookie settings). Defaults to `production` in Docker, where missing `SESSION_SECRET` / `EVE_CLIENT_ID` / `EVE_CLIENT_SECRET` will fail fast at boot. |
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
| `DISCORD_WEBHOOK_URL` | Optional | Discord webhook(s) for corp-intel notifications (inbound K162, new connections). One URL fires for **every** corp map; for multi-corp deployments use `corpId=URL` pairs (comma-separated) to route each corp to its own channel — e.g. `98000001=https://discord.com/api/webhooks/…,98000002=https://discord.com/api/webhooks/…`. Personal maps never notify. Leave unset to disable. Which regions/maps actually notify is then filtered per corp in the admin **Discord** tab. See [Discord notifications](#discord-notifications). |

#### EVE developer app scopes

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
| `esi-fleets.read_fleet.v1` | Read the character's current fleet composition (members + their solar systems) so fleet-mates show up as purple dots on the map with a hover tooltip listing names. Member-list reads require the character to be the **fleet boss**; wing/squad commanders see "in a fleet, no member visibility" and the UI degrades silently. |

**2. Build and start the stack**

The server depends on the EVE Static Data Export (SDE) tables (`map_stargates`, `solar_systems`, `item_types`, …) at boot — without them, route-graph initialisation throws and the container crash-loops. A dedicated `importer` service handles this: it runs once after Postgres is healthy, downloads the SDE (~hundreds of MB from CCP, a few minutes; logs progress per table), populates the static tables, then exits. The server waits for it to finish (`service_completed_successfully`) before booting, so a single command brings everything up in the right order.

```bash
docker compose build
docker compose up -d
```

The app will be available on port `${WEB_PORT:-80}` (defaults to `80`).

The import is self-skipping: on every later `up` or restart the importer sees the static tables are already populated and exits in a second without re-downloading. So the two commands above are also your update flow. To force a re-import (e.g. after a CCP SDE drop), see [Updating the SDE](#updating-the-sde) below.

The importer also stores each system's universe coordinates and CCP's 2D star-map projection (`position` / `position2D`), which power the [Seed a map from a region](#features) feature.

**3. Reverse proxy (optional)**

To front the stack with Traefik for TLS and a public URL, add `DOMAIN=nexum.yourdomain.com` to your `.env`, then:
```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```
Traefik will handle TLS termination and HTTP→HTTPS redirects. The `docker-compose.traefik.yml` overlay assumes a Traefik network named `traefik-public` and a cert resolver named `letsencrypt`.

> **Tip — avoid retyping the overlay.** Every `docker compose ...` command below uses the standard form. If you run with the Traefik overlay, either prefix each command with `-f docker-compose.yml -f docker-compose.traefik.yml`, or set it once per shell session:
> ```bash
> export COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml
> ```
> After that, plain `docker compose ...` automatically loads both files. Add the export to `~/.bashrc` / `~/.zshrc` if it's the only deployment on that host.

App-schema migrations (`users`, `maps`, `map_signatures`, etc.) layer on automatically the first time the server boots — no manual step.

#### Updating the SDE

The static data (systems, stargates, item types, dogma — everything CCP ships in the Static Data Export) is imported into Postgres at first boot and kept current from there. Here's how it stays up to date, how to force it, and how to check which build you're on.

**Automatic (the default — you normally do nothing).** The server checks once a day (default **11:30 UTC**, just after the 11:00 downtime when CCP publishes the new export) — plus a catch-up a few minutes after every restart, so a deploy that missed the daily slot, or a build CCP publishes off-cycle, doesn't leave you stale for ~24h. The check is cheap: a single `HEAD` request reads the build number from CCP's "latest" redirect (`…/eve-online-static-data-<build>-jsonl.zip`) and compares it to the build recorded in the `sde_meta` table. If — and only if — the build changed, the server downloads the new export, re-seeds the static tables, reloads its in-memory route graph in place, then **deletes the downloaded zip** so it doesn't sit on disk. No new build, no download; a re-seed needs no restart.

The re-seed is upsert-only (`ON CONFLICT DO UPDATE` on every table), so it's safe — your user data (maps, signatures, structures, sessions, etc.) lives in other tables and is never touched.

Tune it via `.env`:

| Variable | Default | Effect |
|---|---|---|
| `SDE_AUTO_UPDATE` | `1` (on) | Set to `0` to disable the daily check entirely. |
| `SDE_CHECK_UTC` | `11:30` | Time of day (HH:MM, UTC) to run the check. |

**Forcing an update now** (e.g. to test, right after a known CCP drop, or if you disabled the daily check). Run the importer with `FORCE_SDE_IMPORT=1` — it downloads the latest export and re-seeds regardless of the recorded build:

```bash
# Docker
docker compose run --rm -e FORCE_SDE_IMPORT=1 importer
```

```bash
# Local development (Postgres on localhost)
cd server && FORCE_SDE_IMPORT=1 yarn setup-db
```

**Checking which build you're on.** `GET /api/sde/version` is public and browser-callable — it reports the build this instance is running against the latest CCP currently offers, so you can confirm an update landed (or see that one is pending):

```jsonc
// GET /api/sde/version
{
  "installed":   "3365090",                  // build imported into this DB (null if never seeded)
  "installedAt": "2026-05-29T11:29:00.000Z", // when that build was imported
  "latest":      "3368760",                  // latest build CCP offers (null if CCP unreachable)
  "latestCheckedAt": "2026-06-02T11:30:00.000Z", // when THIS endpoint last queried CCP (cached)
  "upToDate":    false,                       // true | false | null (unknown)
  "autoUpdate":  true,                        // is the daily auto-update enabled?
  "autoCheck": { "at": "2026-06-02T11:30:12.000Z", "result": "updated" } // last auto-update run (null until one fires)
}
```

`installed` vs `latest` are directly comparable — both are CCP build numbers from the same source the importer uses. `upToDate` is `null` ("unknown") rather than a misleading `false` when either build can't be determined (CCP unreachable, or a never-seeded DB).

Two timestamps that are easy to confuse: **`latestCheckedAt`** is when *this endpoint* last asked CCP for the latest build (cached — a single `HEAD`, 1 h on success / 5 min after a failure, so the endpoint is cheap to poll). **`autoCheck`** is when the *auto-updater* itself last ran and what it did (`updated` / `unchanged` / `error` / `skipped`) — that's the field to watch to confirm the daily check is actually firing. It's `null` until the first check runs in the current process. For the full picture, the server also logs each run under the `sde-update` tag (`docker compose logs server | grep sde-update`).

#### Refreshing wormhole types

Mostly automatic. Wormhole stats (destination class, mass limits, lifetime, mass-regen) are derived live from the imported SDE dogma, so a CCP **rebalance** flows in on the next daily re-seed with no action — no `extract-wormholes`, no rebuild.

The only thing the SDE can't provide is `src` ("where can this WH appear") — community knowledge curated in `data/wormholes.json`. When CCP adds a **brand-new WH type** (rare — usually a major expansion), it auto-appears in `/api/wormholes/types` with its derived stats and an empty `src`, and the server logs it as needing curation. To fill in `src`, add the code to `data/wormholes.json` and rebuild:

```bash
# Optional: scaffold any new codes (preserves existing curation, fills new
# entries with placeholder src). Then edit data/wormholes.json by hand.
docker compose run --rm \
  -v "$PWD/server:/app" -w /app -e NODE_ENV=development \
  --entrypoint sh server -c "yarn install --frozen-lockfile && yarn extract-wormholes"
docker compose build server && docker compose up -d
```

See [Static data files](#static-data-files) for what `extract-wormholes` does and the fields involved.

#### Upgrading an existing deployment

Pulling a new Nexum release into a running instance:

- **App-schema changes apply automatically.** New columns and tables (e.g. the map-merge `allow_as_merge_source` / `allow_as_merge_destination` flags, the solar-system coordinate columns) are added by the migration that runs on every server boot — just rebuild and restart:
  ```bash
  docker compose build server && docker compose up -d
  ```

---

### Option 2 — Local development

**Prerequisites:** Node.js 20+, Yarn, PostgreSQL 16.

**1. Clone and configure**

```bash
git clone https://codeberg.org/GQuantrill/eve-nexum.git
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

> The server needs the EVE SDE imported into Postgres before it will boot — run `cd server && yarn setup-db` once (downloads the latest SDE and populates the static tables, including system coordinates).

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

**Shared-in personal maps** — when another user has shared their personal map with you (or with your corp), you can edit signatures, structures, notes, and topology regardless of your global role — the grant is an explicit invitation by the owner. You cannot rename the map, delete it, generate a public share link, or change who else has access; those stay with the owner. Lock state still applies: if the owner is also an admin and locks the map, your topology edits are frozen the same as a locked corp map.

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

### Merging maps

Merging folds a **source** map's contents into a **destination** map. The destination is treated as the source of truth — its systems are never overwritten; only missing systems and connections are added, with signatures, structures, and notes merged in (each toggleable in the merge dialog). Open it from the map sidebar's **Merge Maps** section.

**Who can merge what** — solo and corp maps are gated differently:

- **Solo maps** — you can always merge *from* or *into* a personal map you own, or one that's been shared with you. No special role needed; it's your map (or an explicit grant).
- **Corp maps** are opt-in and gated by role:

| Action | Requirement |
|---|---|
| Use a corp map as a merge **source** | The map has **Allow as merge source** enabled. Any corp member who can view it may then merge *from* it. |
| Use a corp map as a merge **destination** | The map has **Allow as merge destination** enabled **and** the user has `edit` / `full` / `admin` (the same write access as any other corp-map edit). Locked corp maps are excluded for non-admins, since a merge changes topology. |
| Toggle either flag | `full` or `admin` only. |

Both flags default to **off** — a corp map is neither a merge source nor destination until a `full`/`admin` member turns it on. The two toggles live in the same **Merge Maps** sidebar section and are independent: a map can be a source, a destination, both, or neither. The toggles only appear on corp maps; solo maps ignore them.

Every merge that involves a corp map on either side writes an audit entry (`corp_map_merge_source` / `corp_map_merge_destination`) recording who performed it and the source → destination map names. The merge runs in a single transaction, so a failure leaves the destination untouched (no audit entry either).

### What happens when a user leaves the corp

The corp membership check runs **at login**. Existing sessions keep working until the user logs out and back in — at which point ESI is queried again and a corp departure causes the login to fail. Admins can also manually block a user (see below), which prevents login entirely regardless of corp membership.

#### …including `ADMIN_CHAR_ID`

The corp gate is fail-closed and **does not exempt `ADMIN_CHAR_ID`**. If your bootstrap admin character leaves every corp listed in `CORP_ID`, their next login is rejected just like anyone else's, and because they can no longer log in there's no in-app path to recover. This is intentional — a former member walking out of corp with admin keys is exactly who you *don't* want signing back in. To recover you have three options:

1. Move the character back into one of the listed corps in-game and log in again.
2. Edit `.env` to add their new corp to `CORP_ID` and restart the server.
3. Edit the `users` table directly (last resort).

If you want a permanent break-glass, run a second `ADMIN_CHAR_ID`-eligible character in a corp you control and don't plan to leave.

### Discord notifications

Set `DISCORD_WEBHOOK_URL` to push chain intel into a Discord channel so alerts reach people who aren't watching Nexum. It fires **server-side**, so it doesn't depend on anyone having the map open.

**What fires:**

- **Inbound K162** — a signature's wormhole type is set to K162 (something just connected into the chain).
- **New wormhole connection** — a connection is drawn between two systems.

**Scope and behaviour:**

- **Corp maps only.** Personal maps never notify — their scanning stays private.
- **Bulk operations are excluded.** Seeding a region or merging maps creates many connections at once and deliberately does *not* post to Discord; only interactive edits do.
- **Best-effort.** A webhook failure (Discord down, timeout, rate-limit) is logged and dropped — it never affects the edit that triggered it. Delivery is paced and honours Discord's rate limits.

**Configuration** — create a webhook in your Discord channel (Channel → Edit → Integrations → Webhooks) and set the URL:

```bash
# One channel for every corp map:
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/abc

# Multi-corp: route each corp to its own channel (corpId=URL, comma-separated):
DISCORD_WEBHOOK_URL=98000001=https://discord.com/api/webhooks/1/a,98000002=https://discord.com/api/webhooks/2/b
```

The webhook URL is a secret: it lives only in the server env, is never sent to the browser, and is masked in logs. Changing it takes effect on the next server restart. Leave it unset to disable notifications entirely.

**Filtering (admin).** By default every corp map and region notifies. The **Discord** tab in the admin panel lets an admin narrow this per corp, without touching the webhook:

- **Regions** — notify for all regions (default), or only a chosen allowlist. The wormhole's system region is checked at send time; for a new connection, either endpoint's region qualifies.
- **Excluded maps** — every map notifies by default; tick maps to exclude them.

These settings only ever *subtract* from the default, and new maps are always included automatically, so nothing silently goes dark.

### Admin operations

Admins reach the dashboard from the **Admin** button in the toolbar, which lands them at `#/admin/users`. The page has five tabs:

- **Users** — role select, block / unblock, recheck corp via ESI.
- **Maps** — every corp map across every listed corp. Force-lock, force-unlock, force-delete. Solo maps are deliberately excluded — they belong to individual users.
- **Reports** — placeholder for future ops reports.
- **Discord** — per-corp notification filters: a region allowlist and per-map exclusions (see [Discord notifications](#discord-notifications)).
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

## Static data files

Some pre-computed lookups live in `server/data/` as plain JSON, derived once from the EVE Static Data Export (SDE). They're committed to the repo so a fresh install works without an extra step. You only need to regenerate them when CCP releases an SDE drop that adds or changes the underlying data.

The SDE tables themselves (systems, stargates, dogma, …) are imported into Postgres separately and kept current automatically — see [Updating the SDE](#updating-the-sde) for how that works, how to force it, and the `GET /api/sde/version` endpoint for checking which build you're on.

> **A0 sun systems** (`typeID 3801`, "Sun A0 (Blue Small)") used to live here as `data/a0-systems.json`. They're now flagged on `solar_systems.is_a0` directly by the SDE importer (from `mapStars.jsonl`) and served via `GET /api/systems/a0`, so they refresh automatically on every SDE re-seed — no committed file, no manual regen. Note this is the in-game A0 classification (`typeID 3801`), not the SDE's `statistics.spectralClass` field; the two don't agree.

### `data/wormholes.json`

Per-wormhole-type metadata for every connection signature (T405, R943, K162, …) keyed by the in-game 3-letter code, served via `GET /api/wormholes/types` (the client uses it for the wormhole type picker, sig aging tints, and the WH-type info popover).

The numeric stats are **not** read from this file at runtime — the server derives them live from the imported SDE dogma each time it builds the spec list (and rebuilds after every re-seed), so CCP rebalances apply automatically. The deterministic fields and their dogma sources:

| Field | Source |
|---|---|
| `dest` | dogma attribute `1381` (`wormholeTargetSystemClass`) |
| `total_mass` | dogma attribute `1382` (`massWormholeTotal`) |
| `max_mass_per_jump` | dogma attribute `1383` (`massWormholeMaxJumpable`) |
| `mass_regen` | dogma attribute `1384` (`massWormholeMassRegeneration`) |
| `lifetime` | dogma attribute `1503` (`wormholeMaxStableTime`, seconds — converted to hours) |

What this file **does** provide is the one thing CCP doesn't encode anywhere: the `src` array — "where can this wormhole appear" is community/observation knowledge, not data. (`static` and `sibling_groups` live here too but aren't currently served.) The schema follows the [exodus4d/Pathfinder](https://github.com/exodus4d/pathfinder) shape — that project is the original source of the file and is bundled at the repo root for licensing/attribution. A brand-new WH code auto-appears with derived stats and an empty `src`, logged as needing curation; fill it in here and rebuild.

**`extract-wormholes` (optional maintainer helper).** Regenerates this file from the imported SDE — preserving existing `src` / `static` / `sibling_groups` and scaffolding new codes with placeholders — so you have a starting point to curate. The server no longer depends on the stat fields it writes; it's purely for maintaining `src`. Run it after a fresh `yarn setup-db`:

```bash
cd server
PG_HOST=localhost yarn extract-wormholes
```

Or inside Docker via a one-off container (matching the SDE refresh recipe in the Troubleshooting section):

```bash
docker compose run --rm \
  -v "$PWD/server:/app" \
  -w /app \
  -e NODE_ENV=development \
  --entrypoint sh \
  server -c "yarn install --frozen-lockfile && yarn extract-wormholes"
```

The script prints three lists at the end:

- **New codes** since last run — these have `src: []` and `static: false` filled in as placeholders; review them against CCP's patch notes (or the WH's in-game description) and edit by hand.
- **Orphaned codes** — present in old JSON but absent from current SDE. Usually means CCP removed the type (very rare).
- **Unmapped destination classes** — printed only if CCP adds a new class enum we don't know about; if you see this, extend `CLASS_MAP` at the top of `scripts/extract-wormholes.ts`.

K162 is special-cased: it has no single destination class (it's the "return side" of every other connection), so it isn't in dogma; the server serves it from this file verbatim.

Rebuild and restart (`docker compose build server && docker compose up -d`) after editing the file so the new `src` is baked into the image.

---

## Technology overview

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

---

## Troubleshooting

The stack has three services — `web` (nginx), `server` (Node API), and `postgres`. Most issues are isolated to one of them; figure out which is failing first, then pull its logs.

### 1. Which service is failing?

```bash
docker compose ps
```

Look at the **STATUS** column:

| Status | Meaning |
|---|---|
| `Up` / `Up (healthy)` | running normally |
| `Restarting` | crashing on boot — see logs |
| `Exit 1` | failed to start — see logs |
| (missing) | never started — `docker compose up -d` |

You can also probe each layer directly:

```bash
# Web (nginx serving the SPA + proxying /api & /auth)
curl -I http://localhost           # expect HTTP/1.1 200

# Server (Express API)
curl http://localhost:3001/health  # expect {"ok":true}

# Database
docker compose exec postgres pg_isready -U "$PG_USER" -d "$PG_DB"
```

If `curl :3001/health` fails but `docker compose ps` shows the server `Up`, the container is running but the app crashed inside it — check its logs.

### 2. Viewing logs

```bash
# Live tail for one service (Ctrl-C to exit)
docker compose logs -f server
docker compose logs -f web
docker compose logs -f postgres

# Last 200 lines, then exit
docker compose logs --tail=200 server

# Everything in time order across all services (useful for race conditions)
docker compose logs -f --timestamps
```

Server logs are tagged by subsystem — grep for the prefix to narrow the noise:

```bash
docker compose logs server | grep -E '\[(auth|maps|admin|standings|ghost-sites|storms|activity|incursions)\]'
```

### 3. Common failure patterns

| Symptom | Likely cause | Where to look |
|---|---|---|
| `Migration failed:` in server logs, container restarts | DB unreachable or wrong creds | `docker compose logs postgres`; verify `PG_*` in `.env` |
| Login redirect loop / `Authentication failed` | `EVE_CALLBACK_URL` in `.env` doesn't match the URL registered on the EVE Developer app | server logs (`[auth]` lines) |
| Login works but cookies don't persist | `FRONTEND_URL` mismatch, or reverse-proxy stripping `Cookie` header | browser DevTools → Application → Cookies; server logs |
| Blank page on the SPA | nginx serving 404 for `/index.html`, build artifacts missing | `docker compose logs web`; rebuild with `docker compose build web` |
| `502 Bad Gateway` from nginx | `server` container is down | check `docker compose ps`; then server logs |
| Admin page / Reports tab not visible | role isn't `admin` (or `canViewReports`), `CORP_ID` is unset for admin routes | DevTools → Network → `/auth/me` response shows `role` and `canViewReports` |
| ESI features stale (kills, structures, sov) | ESI rate-limited or down | server logs; `https://esi.evetech.net/ui/` for service status |
| Storm / ghost-site lookups not appearing | scraper fetch failed (502 fallback used) | server logs (`[storms]` / `[ghost-sites]`) |

### 4. Local-dev variant

In local-dev mode (`npm run dev` in `server/` and `web/` separately) there are no containers — logs stream straight to the terminal you started them from. Browser-side errors appear in DevTools Console; network failures show in DevTools Network. The Vite dev server proxies `/api` and `/auth` to the local API, so a 502 in the browser network tab means the API process exited.

### 5. Health-check shortcuts

```bash
# Count the rows the server should have populated at boot
docker compose exec postgres psql -U "$PG_USER" -d "$PG_DB" \
  -c "SELECT 'solar_systems' AS t, COUNT(*) FROM solar_systems
      UNION ALL SELECT 'map_regions',  COUNT(*) FROM map_regions
      UNION ALL SELECT 'item_types',   COUNT(*) FROM item_types;"

# Decode a session cookie's user id (paste cookie value as $SID)
docker compose exec postgres psql -U "$PG_USER" -d "$PG_DB" \
  -c "SELECT sess->>'userId' AS user_id, expire FROM sessions WHERE sid = '$SID';"
```

If `solar_systems` is empty the SDE import never ran — check the importer's logs (`docker compose logs importer`) and re-run it with `docker compose run --rm -e FORCE_SDE_IMPORT=1 importer`.

---

## License

Nexum is free software licensed under the [GNU General Public License v3.0 or later](LICENSE) (`GPL-3.0-or-later`). You're free to use, study, modify, and redistribute it; if you distribute a modified version, that version must also be released under the GPL. See [LICENSE](LICENSE) for the full text.

### EVE Online IP notice

EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights are reserved worldwide. All other trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE and all associated logos and designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles, storylines, world facts or other recognizable features of the intellectual property relating to these trademarks are likewise the intellectual property of CCP hf.

CCP hf. has granted permission to Nexum to use EVE Online and all associated logos and designs for promotional and information purposes on its website but does not endorse, and is not in any way affiliated with, Nexum. CCP is in no way responsible for the content on or functioning of this software, nor can it be liable for any damage arising from the use of this software.
