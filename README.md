# Nexum

A wormhole mapping tool for EVE Online. Track systems, signatures, structures, kills, and live activity data across your chain.

---

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

| Variable | Description |
|---|---|
| `PG_PASSWORD` | PostgreSQL password |
| `SESSION_SECRET` | Random secret — run `openssl rand -hex 32` |
| `EVE_CLIENT_ID` | From your EVE developer app |
| `EVE_CLIENT_SECRET` | From your EVE developer app |
| `EVE_CALLBACK_URL` | Must match the callback registered in your EVE app — e.g. `https://yourdomain.com/auth/callback` |
| `FRONTEND_URL` | Public URL of the app — e.g. `https://yourdomain.com` |

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

On first run the server auto-creates its tables. If you need to run migrations manually:

```bash
docker compose exec server node dist/src/scripts/setup-db.js
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

### Key features

- **Interactive map** — drag systems, draw connections, set wormhole class/type/status per connection
- **System panel** — per-system cards for signatures, structures, NPC stations, notes, killboard, and activity charts; cards are reorderable via drag-and-drop
- **Signature management** — paste EVE scan results directly; tracks created/updated age per signature
- **Structure import** — paste EVE overview data to import player-owned structures
- **Activity charts** — 24-hour rolling history of jumps, ship/pod kills, and NPC kills, polled from ESI hourly
- **Sovereignty & station data** — live alliance/corp/faction sov info and NPC station services with in-game waypoint/destination actions
- **Multi-map support** — each character can maintain multiple independent maps
- **Server status widget** — live Tranquility server status, player count, and ESI health in the toolbar
