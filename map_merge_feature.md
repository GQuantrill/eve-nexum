# Merge Map Feature — Build-Ready Spec

## 1. Summary

Allow a user to merge the contents of a **source map** into a **destination map**.
The destination is treated as the source of truth: existing systems are never
overwritten, only augmented. New systems, connections, and (optionally)
signatures, structures, and notes from the source are added or merged in.

The merge runs server-side in a single transaction and reuses the existing
`/import` engine (`server/src/routes/maps.ts:319-489`), which already handles
UUID remapping, `eve_system_id` dedup, and undirected connection dedup.

> Decisions below marked **DECISION (default)** are reasonable defaults chosen
> to make this build-ready. Override any before implementation.

---

## 2. Resolved decisions

### 2.1 System matching ("destination is truth")
Every node is added only via ESI/SDE search (`AddSystemModal.selectResult`), so it
always carries a unique real EVE name **and** a populated `eve_system_id` — including
wormholes (J-numbers are unique SDE entries). There are no anonymous/placeholder
nodes, so a single reliable key suffices:

- **Match key:** `eve_system_id` when both rows have it (canonical); otherwise
  case-insensitive `name` (also unique and always present — covers any legacy row
  with a null `eve_system_id`).
- **Match →** keep the destination row's core fields untouched: `system_class`,
  `effect`, `statics`, `status`, `is_home`, `locked`, `position_x/y`. Only `notes`
  may change, per §2.4. Record `sourceSystemId → destSystemId` in the remap table.
- **No match →** insert as a new node (see positioning, §2.6).

Because names are unique and always present, the same system in both maps dedups
cleanly — there is no duplicate-node risk to warn about.

### 2.2 Connections (always merged — the map skeleton)
- Remap source `source_id`/`target_id` to destination system UUIDs (existing or
  newly inserted).
- Drop self-loops (both endpoints map to the same destination system).
- Dedup by **undirected pair**, seeding the `seenPair` set with the destination's
  *existing* connections so only missing links are added. Existing destination
  connections keep their attributes (truth).
- New connection copies: `connection_type`, `mass_status`, `time_status`, `size`,
  `wh_type`, `source_handle`, `target_handle`.
- Worked example from the brief: Map A has `A–B` and `A–C`; Map B has only `A–B`.
  After merge, Map B gains `A–C`. ✅

### 2.3 Signatures (filterable — only when `include.signatures`)
- **Match key:** trimmed, case-insensitive `sig_id` within the destination system.
- Empty source `sig_id` → always **insert** as new.
- **Match →** `UPDATE` destination row's `sig_type`, `name`, `notes`, `wh_type`,
  `wh_leads_to` from source and set `updated_at = NOW()`.
- **No match →** `INSERT` onto the destination system.

### 2.4 Notes (filterable — only when `include.notes`)
Applies to **system-level** `map_systems.notes`.
- **New systems:** carry their own notes when `include.notes` is on; inserted with
  empty notes when off.
- **Matched systems — DECISION (default): fill-or-append (never silent overwrite).**
  - Destination note empty → copy source note.
  - Both present and differ → append under a divider:
    `\n\n--- merged from "<source map name>" (<YYYY-MM-DD>) ---\n<source note>`
  - Identical → no change.
- When `include.notes` is off: matched systems' notes are untouched; new systems
  are inserted with empty notes.

### 2.5 Structures (filterable — only when `include.structures`)
- **Match key:** `eve_id` when both non-null; otherwise case-insensitive `name`
  within the system. Null `eve_id` + empty name → always **insert**.
- **Match →** `UPDATE` `name`, `structure_type`, `owner_corp`, `owner_corp_id`,
  `eve_id`, `notes`; set `updated_at = NOW()`.
- **No match →** `INSERT` onto the destination system.

### 2.6 Positioning & flags for new nodes
- **Position:** preserve the source cluster's relative layout, offset so it doesn't
  overlap the destination. Compute the destination bounding box and shift incoming
  nodes to its right: `newX = srcX + (destMaxX - srcMinX) + GAP` (GAP ≈ 300).
  Cosmetic; the user can rearrange. **DECISION (default).**
- **`is_home`:** force `FALSE` on all newly-inserted systems — the destination keeps
  its single home. Matched systems untouched.
- **`locked`:** new systems inserted unlocked.

### 2.7 What is NOT merged
- Map-level metadata (name, owner, corp_id, lock state) — destination keeps its own.
- Map shares (`map_shares`) — not copied.
- The source map is **not** modified or deleted by the merge. **DECISION (default):**
  no auto-delete; user removes the source separately if desired. (No quota impact —
  merge creates no new map.)

### 2.8 Audit logging (corp maps)
Whenever a **corp** map is involved in a merge — as source, destination, or both —
record it in the admin audit log. Reuses the existing `admin_audit` table
(`server/src/migrate.ts:320`) and `audit()` helper (`server/src/routes/admin.ts:104`).
**No new table.**

- **Trigger:** evaluate each map's `corpId` (from `getMapAccess`). Write **one audit
  row per corp map involved** — so 0 rows for solo→solo, 1 row if only one side is a
  corp map, 2 rows if both are.
- **Row fields** (mirrors the existing `force_*_map` precedent at `admin.ts:423-464`,
  which targets the map owner):
  - `actor_user_id` / `actor_character_id` — the user performing the merge (from
    session; filled automatically by the helper).
  - `target_user_id` / `target_character_id` — the involved corp map's owner/creator
    (`m.user_id` + `u.character_id`, resolved the same way as `force_*_map`).
  - `action` — `'corp_map_merge_source'` or `'corp_map_merge_destination'` (the side
    this corp map was on).
  - `old_value` — source map name; `new_value` — destination map name. Both rows carry
    the full source→destination pair, so each entry is self-describing: *who* merged,
    *which* corp map, *which side* it was on, and *what* it merged with.
- **Transactional:** audit rows are written **inside the merge transaction** so they
  commit/rollback together with the data change — no orphaned audit entries on a
  failed merge.
  - ⚠️ Implementation note: today `audit()` runs on the global `db` pool, not a
    transaction client, and is module-private to `admin.ts`. To satisfy the above,
    **extract `audit()` into a shared module** (e.g. `server/src/services/audit.ts`)
    and give it an optional executor parameter (pool *or* tx client, defaulting to
    `db`). Then both `admin.ts` and the merge route call it; the merge passes its
    transaction client.

---

## 3. Access control

Uses existing helpers in `server/src/routes/maps.ts`:
`getMapAccess` (`:88`), `requireMapContentWrite` (`:170`). Roles: `readonly`,
`edit`, `full`, `admin`.

### 3.1 Source map eligibility (read)
A map is a valid **source** when the caller can view it (`getMapAccess !== null`)
**and**:
- It is a **solo** map owned by or shared with the caller → always eligible; **or**
- It is a **corp** map with `allow_as_merge_source = TRUE` (see §4).

Corp maps without the flag are excluded from the source dropdown entirely.

### 3.2 Destination map eligibility (write)
Destination must pass `requireMapContentWrite` — which already enforces:
- Solo map owned by caller, or shared with edit access; **or**
- Corp map where the caller has `edit` / `full` / `admin`.
- Lock rules: a locked destination is rejected (same as any other content write).

### 3.3 Other guards
- `sourceId !== destId` (400 otherwise).
- Size cap: reject if source system count exceeds `MAX_IMPORT_SYSTEMS` (413),
  reusing the existing import limit constant.

---

## 4. Schema change

One new column on `maps` (only schema change in this feature):

```sql
-- server/src/migrate.ts (ADD COLUMN IF NOT EXISTS pattern, matches existing style)
ALTER TABLE maps ADD COLUMN IF NOT EXISTS allow_as_merge_source BOOLEAN NOT NULL DEFAULT FALSE;
```

- Meaning: when a **corp** map has this set, members may use it as a merge *source*.
  Has no effect on solo maps (they are always source-eligible to their owner/sharee).
- **Who can toggle it: `full` / `admin` only on that corp map** (confirmed). It is a
  sharing-policy control, so gated higher than ordinary `edit`-level changes.

---

## 5. API

### 5.1 Merge endpoint (new)
```
POST /api/maps/:destId/merge
Body: {
  sourceId: string,
  include: { signatures: boolean, structures: boolean, notes: boolean }
}
```
- Auth: caller must satisfy §3.1 for `sourceId` and §3.2 for `destId`.
- Runs in one transaction (`BEGIN`/`COMMIT`/`ROLLBACK`), mirroring `/import`.
- **200 response (summary counts):**
  ```json
  {
    "added":   { "systems": 0, "connections": 0, "signatures": 0, "structures": 0 },
    "updated": { "signatures": 0, "structures": 0, "systemNotes": 0 }
  }
  ```
- **Errors:** 400 (same map / bad body), 403 (source not readable / corp source not
  flagged / no write on dest), 404 (map not found), 409 (dest locked), 413 (too large).

### 5.2 Toggle "allow as source" (new or extend existing map update)
```
PATCH /api/maps/:mapId   Body: { allowAsMergeSource: boolean }
```
- Auth per §4 (full/admin on the corp map). Solo maps: reject or no-op.

### 5.3 Maps list — add fields (`GET /api/maps`, `maps.ts:214`)
Add to the SELECT so the modal can render dropdowns and filter sources:
- `allow_as_merge_source AS "allowAsMergeSource"`
- Owner display name: join `users` for the owner `character_id` and resolve via the
  existing `resolveEntityNames` service (or carry the stored character name).
  Used for the "owner · solo/corp · name" option label.

---

## 6. Merge algorithm (server)

New service function, e.g. `server/src/services/mergeMap.ts`, called by the route.
Adapts `/import` (`maps.ts:387-483`):

1. Load destination systems → build `destByEveId` and `destByName` lookup maps
   (eve_system_id / lowercased name → destination system UUID + row).
2. Load destination connections → seed `seenPair` (undirected keys).
3. Load source systems + connections (+ signatures/structures per filters).
4. Resolve source systems lacking `eve_system_id` by name against `solar_systems`
   (reuse the batch `nameToId` resolution at `maps.ts:397-409`).
5. For each source system, build `srcSystemId → destSystemId`:
   - match in destination (§2.1) → map to existing UUID, queue note merge (§2.4);
   - else → new UUID, queue insert (offset position, `is_home=false`).
6. Bulk-insert new systems.
7. Remap + dedup connections (§2.2), bulk-insert the survivors.
8. If `include.signatures`: per destination system, upsert by `sig_id` (§2.3).
9. If `include.structures`: upsert by eve_id/name (§2.5).
10. Apply queued system-note merges (§2.4).
11. For each map whose `corpId !== null` (source and/or destination), write a
    `corp_map_merge_source` / `corp_map_merge_destination` audit row **on the
    transaction client** (§2.8).
12. `COMMIT`; return summary counts.

---

## 7. Frontend

### 7.1 Merge modal (new component)
- **Source Map** dropdown — options = source-eligible maps (§3.1), label
  `owner · solo|corp · name`.
- **Destination Map** dropdown — options = write-eligible maps (§3.2), same label.
- **Filters** (checkboxes, default on): Signatures, Structures, Notes. Systems and
  connections always merge (not shown as toggles).
- **Disclaimer** at the bottom of the modal: *"This action cannot be undone."*
- **Confirm** disabled until source and destination are both chosen and differ.
- On submit: `POST /api/maps/:destId/merge`, show a toast with summary counts, then
  `useMapStore.switchMap(destId)` to reload the destination. Other clients refresh on
  their next map load (no live push exists today).

### 7.2 Entry point
- "Merge maps…" action in the map-management UI (`MapSidebar` / map menu).

### 7.3 Corp map setting
- "Allow as merge source" toggle with helper text in the corp map settings/shares UI
  (`MapSharesSection`), gated to full/admin. Wire to `PATCH /api/maps/:mapId`.

---

## 8. Edge cases & test plan

- Solo→solo, same owner: no extra controls (per brief).
- Corp map as destination with `readonly`/`edit`/`full`/`admin`: only edit+ succeed;
  read-only corp maps never appear as destination.
- Corp map as source with flag off vs on: excluded vs included in dropdown.
- System match by `eve_system_id`: merged, core fields preserved.
- Legacy row with null `eve_system_id`: matched by unique `name`.
- Connection union: `A–C` added, existing `A–B` not duplicated; self-loops dropped.
- Signature with matching `sig_id`: updated + `updated_at` bumped; empty `sig_id`:
  always added.
- Structure match by `eve_id`; fallback by name; null/empty: always added.
- Notes off: matched notes untouched, new systems blank. Notes on: fill-or-append.
- `sourceId === destId` → 400. Locked destination → 409. Oversized source → 413.
- Transaction rollback on mid-merge failure leaves destination unchanged **and writes
  no audit row**.
- Audit: solo→solo writes 0 rows; corp source only → 1 (`corp_map_merge_source`);
  corp dest only → 1 (`corp_map_merge_destination`); corp→corp → 2 rows. Each row
  shows actor, the corp map's owner as target, and the source/destination names.

---

## 9. Work breakdown

| Area | Files | Est. |
|---|---|---|
| Migration (`allow_as_merge_source`) | `server/src/migrate.ts` | 0.25d |
| Merge service + route | `server/src/services/mergeMap.ts`, `server/src/routes/maps.ts` | 1.0d |
| Extract shared `audit()` (optional tx-client arg) + corp-map merge logging | `server/src/services/audit.ts`, `server/src/routes/admin.ts`, merge route | 0.25d |
| List endpoint fields + toggle endpoint | `server/src/routes/maps.ts` | 0.5d |
| Merge modal + entry point | `web/src/components/ui/*`, `web/src/store/mapStore.ts` | 1.0d |
| Corp "allow as source" toggle UI | `web/src/components/ui/MapSharesSection.tsx` | 0.25d |
| Tests (edge cases above) | — | 0.5–1.0d |

**Total: ~3.25–3.75 days.** Low architectural risk — the core engine and audit
infrastructure already exist.
