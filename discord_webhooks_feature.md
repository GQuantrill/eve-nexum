# Discord Webhook Notifications — Design

## 1. Goal

Push high-signal chain intel to a corp's **Discord channel** so alerts reach
people who aren't staring at the Nexum tab. Today every alert (K162, proximity,
kills) lives and dies in the browser. This is **server-side, best-effort, and
corp-scoped**.

Decisions: **corp-wide via env var** (matches every other corp setting — no
schema, no UI), v1 events = **inbound K162** + **new wormhole connection**.

## 2. Scope & non-goals

- **Corp maps only** (maps with a `corp_id`). Personal maps never notify — their
  scanning is private and shouldn't leak into a corp channel.
- **v1 events:** inbound K162 (a signature's WH type set to `K162`), and a new
  wormhole connection drawn interactively.
- **Excluded:** kills (no server-side poller exists — they're fetched on-demand;
  a kill feed would need a new background job → phase 2); proximity alerts
  (per-user and location-based, not a map-wide event); system-add (too noisy with
  passive auto-add); and **all bulk paths** (region seed, map merge) which must
  never fire.
- **Best-effort:** a webhook failure (timeout, 4xx/5xx, Discord down) never
  affects the user's action or the request response.

## 3. Config — `config.ts`

New env var `DISCORD_WEBHOOK_URL`, parsed in the existing config style. Two forms:

- A single URL → used for **every** corp map.
- `corpId=URL,corpId=URL` pairs → per-corp routing for multi-corp deployments
  (`CORP_ID` is already a list). `=` separates id from URL because URLs contain
  `:`; entries are comma-separated (Discord webhook URLs contain no commas). A
  bare `http(s)://…` entry sets the default.

Resolve: `webhookFor(corpId) = byCorp[corpId] ?? defaultUrl ?? null`. Feature is
**disabled** (no-op) whenever the resolved URL is null. Export as
`config.discord = { defaultUrl, byCorp }` + a `webhookFor(corpId)` helper.

## 4. Service — `services/discord.ts` (new)

- `webhookFor(corpId): string | null`.
- `notifyDiscord(corpId, embed)` — resolve URL; if none, return. Push
  `{ url, embed }` onto an in-memory queue and kick the drain. **Never throws.**
- **Drain** (self-scheduling, no global interval needed): POST queued items
  sequentially with ~1 s spacing, `AbortSignal.timeout(5000)`, JSON body
  `{ embeds: [embed] }`. On HTTP 429 honour `retry_after`; on other failure log
  and drop. Cap the queue (~100) and drop overflow with a single warn so a
  pathological burst can't grow unbounded. Mask the URL in any log line.
- **Embed builders** returning Discord embed JSON (`{ title, description, color,
  fields?, footer?, timestamp }`):
  - `k162Embed({ system, systemClass, mapName, actor })`
  - `connectionEmbed({ a, b, whType, size, mapName, actor })`

Models the existing native-`fetch` pattern (killboard.ts / admin.ts). Same
single-instance assumption as the SSE and presence registries.

## 5. Detection & dispatch — in `routes/maps.ts` route handlers

Hook in the **specific interactive handlers**, *not* the central
`publishToMap` bus — that's what keeps bulk paths (seed/merge, which don't go
through these handlers) from flooding the channel.

Each dispatch is guarded by: map has a `corp_id` **and** `webhookFor(corpId)` is
non-null. Fired fire-and-forget (call `notifyDiscord(...)`, don't `await` before
responding).

- **Inbound K162** — in the signature **add** (POST) and **update** (PATCH)
  handlers:
  - PATCH: only when `whType` is in the body. Read the **previous** `wh_type`
    first (small `SELECT` / `RETURNING` of the old row); fire only on the
    transition `prev !== 'K162' && next === 'K162'` (mirrors the client's
    `SignaturePane` transition check — avoids re-firing on later edits).
  - POST: fire if the new sig's `wh_type === 'K162'`.
  - Payload needs: the signature's **system name + class**, the **map name**,
    `corp_id`, and the acting character name (from the session). Pull the few
    missing fields with a minimal query if not already in scope.
- **New wormhole connection** — in the connection **add** (POST) handler, after
  insert: source/target system names, `wh_type`/`size` if set, map name, actor.

## 6. Message format (embeds)

- **K162** — title `⚠️ Inbound K162`, description
  *"New K162 in **J123456** (C3) — something just connected into **<map>**."*,
  amber colour, footer `set by <actor>`, `timestamp`.
- **Connection** — title `🔗 New connection`, description
  *"**J123456** ↔ **J654321**"* plus a `Type` / `Size` field when known, blue
  colour, footer `added by <actor>`.

## 7. Rate limiting / safety

- Discord allows ~30 requests/min per webhook. Our volume is low because bulk
  paths are excluded; the sequential drain with spacing + 429 handling is ample.
- The URL is a **secret**: env-only (never persisted, never sent to the client),
  masked in logs.

## 8. Phased rollout

1. `config.ts` parsing + `services/discord.ts` (queue, sender, embed builders).
2. K162 dispatch (sig add + patch transition).
3. New-connection dispatch (POST connection only).
4. Docs: README (`DISCORD_WEBHOOK_URL` in env table + Corp mode + a feature
   bullet), landing-page card, `.env.example` if present.
5. **(Phase 2, separate)** kills feed — needs a new zKill background poller.

## 9. Notes / risks

- **Single instance**, in-memory queue — identical assumption to the SSE/presence
  services. A multi-instance deploy would double-send; acceptable for now.
- **Excluding bulk paths is essential** — a region seed creates hundreds of
  connections; routing those to Discord would be a disaster. Hooking the
  interactive handlers (not the event bus) gives this for free.
- **Personal-map exclusion** keeps private scanning out of the corp channel.
