# External Read API & API Keys — Design

## 1. Goal

Let **other tools** read (and later drive) a user's Nexum maps programmatically:
pull the live chain into a fleet bot, an intel aggregator, a "is home open to
highsec?" checker, or the user's own scripts. Authenticated with a **long-lived
API key** the user generates, not a browser session.

This is the *inbound* counterpart to the already-shipped *outbound* Discord
notifications (see [discord_webhooks_feature.md](./discord_webhooks_feature.md)).
Discord pushes a curated, corp-scoped slice of intel **out**; this lets approved
clients pull map state **in**. They are independent features.

## 2. Scope & non-goals

- **v1 = read-only.** `GET` map list, full map, and per-system signatures /
  connections / structures / anomalies. No writes in v1.
- **Account-scoped keys** (see §4) — a key acts as one owner, with one bound
  character for role/corp context.
- **Reuse existing authorization.** A request authenticated by an API key must
  see *exactly* what that owner/character sees in the app — no new permission
  surface. It flows through the existing `getMapAccess()` / role gates in
  `routes/maps.ts`.
- **Out of scope (v1):** write/mutate endpoints (phase 3); OAuth-style
  third-party app authorization; per-endpoint granular scopes beyond a coarse
  `read` / `events` (room left in the schema, not built); public/unauthenticated
  data access (the existing share-token endpoint already covers read-only public
  snapshots — this feature is for *authenticated* programmatic access).

## 3. Relationship to what already exists

- **Auth today** is EVE SSO → Postgres-backed `express-session` cookies; the
  session carries `userId`, `characterId`, `ownerId`, `role`, `userCorpId`
  (`session.d.ts`). Map routes are gated by `requireAuth` and `getMapAccess()`
  (`routes/maps.ts`).
- **Ownership pivots on `owner_id`** (the `owners` account layer). Personal maps
  belong to an owner; corp maps to a `corp_id`; explicit grants live in
  `map_shares`. This is *why* account-scoped keys are the natural fit (§4).
- **Live events** already exist: the SSE stream at `GET /api/maps/:mapId/events`
  (`routes/maps.ts:1313`) fed by the central `publishToMap()` seam
  (`services/mapEvents.ts`). Phase 2 below reuses it directly.
- **No key system exists yet.** The only `Bearer` usage in the server is the EVE
  **ESI** access token sent *outbound* to CCP — unrelated.

## 4. Auth model — account-scoped keys with a bound character

A key is scoped to an **owner** (account), not a single map (the
Wanderer-style map-scoped key would force a parallel auth path and break on
character switching). But `role` and `corp_id` are **character-level**
(`users.role`, `users.corp_id`), so each key is **bound to one character** that
supplies the role/corp context.

A request authenticated by key `K` (owner `O`, bound character `C`) sees:
- all of `O`'s **personal** maps,
- all maps explicitly shared to `C` or `C`'s corp via `map_shares`,
- `C`'s **corp** maps (subject to corp-mode config),
- acting with **`C`'s role** (admin/full/edit/readonly), optionally *downgraded*
  by the key's `scope`.

This is precisely what the session already computes — so the key middleware just
populates the same request fields and **every existing check works unchanged**.

## 5. Data model (migration in `server/src/migrate.ts`)

Idempotent `CREATE TABLE IF NOT EXISTS`, matching the existing migration style.

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         INTEGER     NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  -- character whose role/corp this key acts with; NULL if that char is removed
  context_user_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  token_hash       TEXT        NOT NULL UNIQUE,   -- sha-256 hex of the raw key
  token_prefix     TEXT        NOT NULL,          -- first ~8 chars, for display/lookup hint
  name             TEXT        NOT NULL,          -- user label ("fleet bot")
  scope            TEXT        NOT NULL DEFAULT 'read',  -- 'read' | 'events' (write later)
  last_used_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,                   -- NULL = no expiry
  created_by_user_id INTEGER   REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens(owner_id);
```

**Why hash, not encrypt:** unlike the EVE tokens (`tokenCrypto.ts`, AES-GCM,
which must be *decrypted* to call ESI), an API key is only ever *compared*. Store
a one-way **sha-256** of the raw key; a DB leak then exposes no usable keys. The
raw key is shown to the user **once** at creation and never again. `token_prefix`
lets the UI show "nxm_3f9a…" in the key list without storing the secret.

Key format: `nxm_<32+ random url-safe bytes>`. Lookup by `token_hash` (unique),
then constant-time compare as defence in depth.

## 6. Middleware — `apiKeyAuth`

New `server/src/middleware/apiKeyAuth.ts`:

1. Read `Authorization: Bearer <key>`. If absent, `next()` (let session auth or
   the route's own `requireAuth` handle it — so routes can accept *either*).
2. `sha256(key)` → `SELECT … FROM api_tokens WHERE token_hash = $1`.
3. Reject (401) if not found, `expires_at` passed, or `context_user_id` is NULL
   (bound character was removed → key inert until rebound/rotated).
4. Load the bound character's `role` + `corp_id`; populate the request with the
   **same shape the session sets** (`userId = context_user_id`,
   `ownerId = owner_id`, `role`, `userCorpId`), plus `req.apiScope = scope`.
5. `UPDATE … SET last_used_at = NOW()` (throttle to ≤1/min per key to avoid a
   write per request).

Mount it **before** `requireAuth` on `/api/maps` read routes so a Bearer key is
an alternative to the cookie. `requireMapContentWrite` / `requireMapWrite`
additionally check `req.apiScope !== 'read'` once writes exist (§9 phase 3).

## 7. Endpoints (v1, read-only)

Reuse the existing map read handlers — they already call `getMapAccess()`, which
now resolves via the key-populated request. Surfaced under a stable, versioned
prefix so the programmatic contract is decoupled from the cookie UI routes:

- `GET /api/v1/maps` — maps visible to the key
- `GET /api/v1/maps/:mapId` — full map (systems + connections)
- `GET /api/v1/maps/:mapId/systems/:systemId/signatures`
- `GET /api/v1/maps/:mapId/systems/:systemId/connections` *(or top-level
  `/maps/:mapId/connections`)*
- `GET /api/v1/maps/:mapId/systems/:systemId/structures`
- `GET /api/v1/maps/:mapId/systems/:systemId/anomalies`

Implementation: thin `/api/v1` router that applies `apiKeyAuth` + the existing
access checks and delegates to the same query logic the session routes use
(extract shared read helpers if needed). Document the JSON shapes (they already
exist as the SSE/REST payloads).

**Key-management routes** (cookie-authed, in the app UI — *not* key-authed):
- `GET    /api/keys` — list the owner's keys (id, name, prefix, scope,
  last_used_at, expires_at; never the secret)
- `POST   /api/keys` — create; body `{ name, contextCharacterId, scope?,
  expiresAt? }`; returns the raw key **once**
- `DELETE /api/keys/:id` — revoke

## 8. Live events for tools (phase 2)

The SSE endpoint `GET /api/maps/:mapId/events` already streams structured events
from `publishToMap()`. Add `apiKeyAuth` (scope `events`) as an alternative to the
session on this route — tools then get the **same** live feed the web client
uses, for almost no new code. Unlike the Discord feature (which deliberately
avoids the `publishToMap` bus to skip bulk paths), tapping the full stream is
correct here: a tool wants everything and filters its own side. Document the
event taxonomy (`system.add`, `connection.update`, `sig.changed`, …) as the
public contract; consider freezing the strings behind a shared enum at that
point.

## 9. Phased rollout

1. Migration (`api_tokens`) + `apiKeyAuth` middleware + key-management routes +
   a "API keys" section in the user/profile UI (create/list/revoke, show-once).
2. `/api/v1` read endpoints over the existing access checks; document JSON shapes.
3. `apiKeyAuth` on the SSE endpoint (scope `events`); publish the event contract.
4. (Later, on demand) write endpoints — gate on `scope`/role via the existing
   `requireMapWrite` / `requireMapContentWrite`.

## 10. Rate limiting / safety

- Reuse the existing rate-limiter middleware pattern (the app already has
  auth/esi/app/public limiters); add a per-key limiter keyed on token id.
- Keys are secrets: shown once, stored hashed, masked in logs, revocable.
- Record create/revoke in the existing **audit log** for parity with admin
  actions.
- **Blast radius:** an account-scoped key sees all the owner's maps. Mitigations:
  the `scope` field (read/events only in v1), optional `expires_at`, one-click
  revoke, and `last_used_at` for spotting stale/leaked keys. A future per-key
  **map allowlist** column can narrow a key to specific maps if a Wanderer-style
  single-map key is ever wanted — schema-compatible, not built in v1.

## 11. Notes / risks

- **Single-instance** assumptions elsewhere (SSE/presence/Discord queue) don't
  affect REST reads. The SSE-for-tools step (phase 2) inherits the same
  single-process caveat as the existing stream; the documented fix is the same
  `publishToMap` → Postgres `LISTEN/NOTIFY` swap.
- **Bound-character churn:** if the bound character is removed from the owner,
  the key goes inert (`context_user_id` → NULL) rather than silently escalating
  or acting headless. Surfaced in the key list; user rebinds or revokes.
- **Demand-gated:** v1 is intentionally read + events only. Writes add real
  surface and should wait for a concrete consumer that needs them.
