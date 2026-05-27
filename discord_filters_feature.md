# Discord Notification Filters (Admin) - Design

## 1. Goal

Let a corp control which Discord wormhole notifications it actually receives,
from an admin-panel "Discord" tab, instead of getting a ping for every wormhole
on every corp map. Two independent filters, both applied at send time:

- **Region filter** (per corp): notify for all regions (default), or only a
  chosen allowlist of regions.
- **Map exclusions** (per map): every map notifies by default (auto opt-in);
  admins pick maps to *exclude*.

Builds directly on the existing Discord webhook feature
([discord_webhooks_feature.md]) and its `dispatchK162` / `dispatchNewConnection`
helpers in `server/src/routes/maps.ts`.

## 2. Decisions (locked)

- Webhook URL stays in **env** (`DISCORD_WEBHOOK_URL`); this feature does NOT
  move it into the DB or UI.
- Filter on **both** EVE region and per-map (both filters apply, AND'd).
- Maps are **auto opt-in**; the per-map control is framed as "exclude" because
  the default is on.
- The region check is **generic** - it runs for *any* wormhole notification
  (K162 today, anything later), resolved from the event's system region at send
  time. Not K162-specific.

## 3. Data model (migration in `server/src/migrate.ts`)

Follows the existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE TABLE
IF NOT EXISTS` idempotent pattern.

```sql
-- Per-map opt-out. DEFAULT TRUE means every existing and future map notifies
-- unless explicitly excluded (fail-open - no map silently goes dark).
ALTER TABLE maps ADD COLUMN IF NOT EXISTS discord_notify BOOLEAN NOT NULL DEFAULT TRUE;

-- Per-corp region filter. No row => defaults (all_regions = true) => notify all.
CREATE TABLE IF NOT EXISTS corp_discord_settings (
  corp_id      INTEGER     PRIMARY KEY,
  all_regions  BOOLEAN     NOT NULL DEFAULT TRUE,
  regions      TEXT[]      NOT NULL DEFAULT '{}',   -- region NAMES (match map_systems.region_name)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Region **names** (not ids) are stored, because `map_systems` carries
`region_name` (text) - so the filter is a direct `region_name = ANY(regions)`
compare with no extra join. The admin UI gets `{id, name}` from
`GET /api/regions` and sends the chosen names.

## 4. The filter

A single shared gate, run before every `notifyDiscord(...)` call:

```
notify  ==  mapNotEnabled? no
            AND ( all_regions OR any(eventRegion) IN regions )
```

- **map gate:** `maps.discord_notify` is true.
- **region gate:** corp `all_regions` true, OR at least one of the event's
  system regions is in the allowlist.
- **K162 / single-system events:** region set = `[system.region_name]`.
- **New connection (two endpoints):** region set =
  `[source.region_name, target.region_name]` - passes if *either* side is in an
  allowed region (the wormhole "appears in" a watched region from one side).
- **Unknown region** (`region_name` null, e.g. some manual/J-space systems):
  matches nothing, so when an allowlist is active such events are suppressed;
  with `all_regions` (default) they still notify. Documented behaviour.

### Where it lives
Fold the lookup into the queries the dispatch helpers already run (they join
`maps` + `map_systems`), adding `m.discord_notify`, the system `region_name`(s),
and a `LEFT JOIN corp_discord_settings cds ON cds.corp_id = <corp>`. Then a tiny
pure helper decides:

```ts
function regionAllowed(allRegions: boolean, allow: string[], names: (string|null)[]): boolean {
  if (allRegions) return true;
  return names.some((n) => n != null && allow.includes(n));
}
// notify = mapEnabled && regionAllowed(...)
```

No new query round-trips; one extra join + column on the existing dispatch
reads. (corp settings are tiny and rarely change - an optional in-memory TTL
cache keyed by corpId can come later if needed.)

## 5. Server API (`server/src/routes/admin.ts`)

All under the existing admin gating. Reads on `adminReadRouter`
(`requireAdminRead`), writes on `adminRouter` (`requireAdmin`). Scope to the
admin's own corp via `req.session.userCorpId` (multi-corp safe).

- `GET /api/admin/discord` -> `{ allRegions, regions: string[], maps: [{ id, name, excluded }] }`
  - settings for the caller's corp (defaults if no row), plus that corp's maps
    with their `excluded` (= `NOT discord_notify`) state.
- `PUT /api/admin/discord` -> body `{ allRegions, regions }` -> upsert
  `corp_discord_settings` (`ON CONFLICT (corp_id) DO UPDATE`). Validate `regions`
  against known region names.
- `PATCH /api/admin/maps/:mapId/discord` -> body `{ excluded: boolean }` ->
  set `maps.discord_notify = NOT excluded` (verify the map belongs to the
  caller's corp).
- Region list for the picker reuses the existing `GET /api/regions`.

Optionally record changes in the **audit log** (the app already has one) -
"discord region filter changed", "map excluded/included" - for parity with other
admin actions.

## 6. Admin UI - new "Discord" tab (`web/src/components/ui/AdminPage.tsx`)

- Add `'discord'` to the `Tab` type and `ALL_TABS`
  (`{ key: 'discord', label: 'Discord', path: '/admin/discord' }`), gated to
  `isAdmin` (like Maps/Audit), rendered as `<DiscordTab />`; add to `pathToTab`.
- **DiscordTab** sections:
  1. **Region filter** - a toggle: "Notify for all regions" vs "Only selected
     regions". When "selected": a searchable multi-select (same data/UX as the
     create-map region picker) showing chosen regions as removable chips. Save
     -> `PUT /api/admin/discord`.
  2. **Excluded maps** - the corp's maps listed with an "Exclude from Discord"
     checkbox each (unchecked = notifying, the default). Toggling ->
     `PATCH /api/admin/maps/:id/discord`. Copy makes clear maps notify by
     default and this list is the exceptions.

## 7. Defaults & migration safety

- `discord_notify DEFAULT TRUE` + no `corp_discord_settings` row (=> `all_regions`
  true) means **out of the box every map and region still notifies exactly as
  today**. The filters only ever subtract once an admin configures them, and new
  maps are always included automatically.

## 8. Edge cases

- **No settings row:** treat as `all_regions = true`, `regions = []`.
- **Map deleted:** `discord_notify` goes with it (cascade). Excluding then
  deleting is a no-op.
- **Multi-corp:** everything is keyed by corp; an admin only sees/edits their
  corp's settings and maps.
- **Unknown/J-space region:** see section 4 - suppressed under an active
  allowlist, notified under `all_regions`.
- **Personal maps:** unchanged - they never notify (no `corp_id`); this feature
  only concerns corp maps.

## 9. Phased rollout

1. Migration (`maps.discord_notify`, `corp_discord_settings`).
2. Filter wiring in `dispatchK162` / `dispatchNewConnection` (+ the
   `regionAllowed` helper) - reads the new column/table; defaults keep current
   behaviour.
3. Admin API (`GET`/`PUT /api/admin/discord`, `PATCH .../maps/:id/discord`).
4. Admin "Discord" tab UI (region filter + excluded maps).
5. (Optional) audit-log the changes; in-memory cache for corp settings.

## 10. Notes / risks

- Region filtering is most meaningful for k-space / region-map usage; for pure
  J-space home chains region names are opaque, where the per-map exclude is the
  more useful lever. Both are provided, so each corp uses whichever fits.
- Single-instance assumption is irrelevant here (DB-backed config), unlike the
  in-memory webhook queue.
- Keep the webhook a deploy-level secret (env); this tab never shows or stores
  it.
