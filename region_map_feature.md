# Seed Map From Region — Build-Ready Spec

## 1. Goal

Fold region seeding into the **normal create-map flow**: creating a new map opens a
modal with a name, a personal/corp selector (for users with corp roles), and an
optional region search. Leave the region blank → a normal **blank map**. Pick a
region → the map is **pre-populated with that entire region** — all its solar systems
positioned by their real EVE coordinates (a Dotlan-style layout) and all intra-region
stargate connections. Either way it's an ordinary map afterwards (annotate, merge,
share, etc.).

Reuses the existing `/import` insert pattern (`server/src/routes/maps.ts`), the
`map_stargates` graph (already used by `routeGraph.ts`), and the React Flow map
renderer. The only new *data* requirement is per-system coordinates (see §2).

---

## 2. Data prerequisite — coordinates (operational step)

`solar_systems` does **not** currently store coordinates, but the SDE the seed
already downloads does: `mapSolarSystems.jsonl` carries `center: [x, y, z]`
(universe metres). `setup-db.ts → importSolarSystems` reads `name`,
`securityStatus`, `constellationID` but skips `center`.

**Changes:**
1. **Migration** (`migrate.ts`): `ALTER TABLE solar_systems ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION; … pos_y …; pos_z …;` (nullable — backfilled).
2. **Seed** (`setup-db.ts`): read `o.center` (`[x,y,z]`) and store into `pos_x/pos_y/pos_z`; add the 3 columns to the INSERT + `ON CONFLICT … DO UPDATE`.
3. **Backfill**: either re-run `npm run setup-db` (full re-import; safe/idempotent),
   or a small one-shot script that reads the cached SDE zip in `server/data/` and
   only `UPDATE`s the coordinate columns — avoids a full re-seed. **DECISION (default):
   ship the backfill script** so existing deployments don't need a full re-import.

> Until coordinates are populated the feature can't position nodes; the seed-from-region
> endpoint should 503 with a clear message if a region's systems have null coords.

Only `pos_x` and `pos_z` are used for the 2D layout (`y` is the galactic "up" axis,
dropped — same as Dotlan). `pos_y` is stored anyway for completeness/future use.

---

## 3. Coordinate projection (per region)

Project each system's `(pos_x, pos_z)` to screen coordinates, normalised per region
with aspect ratio preserved (so the region keeps its real shape):

```
xs = systems.map(pos_x); zs = systems.map(pos_z)
minX, maxX = range(xs);  minZ, maxZ = range(zs)
rangeX = max(maxX - minX, 1);  rangeZ = max(maxZ - minZ, 1)   // guard degenerate

// Canvas grows with system count so nodes don't crowd (~220px nominal spacing).
SIDE  = max(1200, round(sqrt(count) * 220))
scale = min(SIDE / rangeX, SIDE / rangeZ)                      // uniform → no distortion

screenX = (pos_x - minX) * scale
screenY = (maxZ - pos_z) * scale                               // flip Z so north is up
```

- Stored into `map_systems.position_x / position_y`.
- Edge crossings will be denser than Dotlan's hand-tuned layout — acceptable per the
  agreed "coordinate projection" fidelity. Not a pixel copy of Dotlan.

---

## 4. Backend

### 4.1 Region list — `GET /api/regions`
Returns regions for the picker:
```sql
SELECT r.id, r.name, COUNT(s.id) AS "systemCount"
  FROM map_regions r
  LEFT JOIN solar_systems s ON s.region_id = r.id
 GROUP BY r.id, r.name
 ORDER BY r.name;
```
Optionally filter out non-playable / WH regions, or just return all and let the UI search.

### 4.2 Seed from region — `POST /api/maps/from-region`
Body: `{ regionId: number, name?: string, isCorpMap?: boolean }`. Auth + quota mirror
`POST /api/maps/import` (personal vs corp tier; corp needs full/admin). Single
transaction:

1. Load region systems:
   ```sql
   SELECT id, name, security, class, effect, statics, pos_x, pos_z
     FROM solar_systems WHERE region_id = $1;
   ```
   - If empty → 404. If any `pos_x/pos_z` null → 503 ("coordinates not seeded; re-run setup-db").
   - Guard `count > MAX_IMPORT_SYSTEMS` (no real region exceeds 500, but keep the cap).
2. Insert `maps` row (name defaults to region name).
3. Project (§3) → bulk-insert `map_systems`: `eve_system_id = id`, `system_class = class`,
   `effect`, `statics`, `region_name = <region name>`, `status='unknown'`, `is_home=false`.
   Build `eveSystemId → new map_system UUID` map.
4. Intra-region stargates → connections:
   ```sql
   SELECT system_id, destination_system_id FROM map_stargates
    WHERE system_id IN (region systems) AND destination_system_id IN (region systems);
   ```
   Remap to UUIDs, **dedup undirected pairs** (each gate has a reverse twin), drop
   self-loops, bulk-insert `map_connections` (`connection_type='standard'`, `size='large'`).
5. `COMMIT`; return `{ id }`.

(No audit/merge concerns — this only creates a fresh map. If the new map is a corp map,
reuse the same corp-map conventions as `POST /api/maps`.)

---

## 5. Frontend — unified "Create map" modal

Region seeding is folded into the **normal new-map flow**, not a separate entry.
Today the toolbar map dropdown has two actions ("+ Personal Map" / "+ Corp Map")
that open a `PromptModal` for the name and call `createMap(name, isCorpMap)`
(`Toolbar.tsx:286,298,476-489`). Replace both with a single **"+ New Map"** action
that opens a new `CreateMapModal`.

**`CreateMapModal` fields:**
- **Map name** — text input. Defaults to `New Map`; if a region is selected and the
  name is still untouched/default, default it to the region name.
- **Type** — Personal / Corp dropdown, shown **only when the user has corp roles**
  (`user.corpMode && canManageMaps`, mirroring the current "+ Corp Map" gate).
  Hidden → personal. Reflect limits: disable/annotate Corp when at corp-map limit,
  block submit when at the relevant tier limit (server still enforces).
- **Region** — searchable dropdown/text-search from `GET /api/regions` (show system
  count). **Blank = blank map.** Selected = seed that region's systems + gates.

**On submit:**
- No region → `createMap(name, isCorpMap)` (existing `POST /api/maps`).
- Region selected → `POST /api/maps/from-region` `{ regionId, name, isCorpMap }`.
- Both paths then `loadMaps()` → `switchMap(id)` → toast, then close.

Reuses the modal markup/classes from `MergeMapModal` / `AddSystemModal`. The old
`PromptModal`-based naming and the dual create buttons are removed.

---

## 6. Edge cases & caveats

- Region with null coords → 503 with a "re-run setup-db" message (until backfilled).
- Degenerate ranges (all systems near-collinear) → range guard keeps them on a line
  rather than dividing by zero.
- Large regions: still under the 500 cap; bulk inserts (batched like `/import`).
- Not a pixel-for-pixel Dotlan copy — same topology and overall shape, denser crossings.
- Constellation grouping/labels: out of scope for v1 (could colour nodes by
  constellation later).

---

## 7. Work breakdown

| Area | Files | Est. |
|---|---|---|
| Coords: migration + seed read `center` + backfill script | `migrate.ts`, `setup-db.ts`, `scripts/backfill-coords.ts` | 0.5d |
| `GET /api/regions` | new `routes/regions.ts` (or in `systems.ts`) | 0.25d |
| `POST /api/maps/from-region` (projection + insert) | `maps.ts` | 0.75d |
| Unified `CreateMapModal` (name + type + region search), replace dual buttons + `PromptModal` | `web/src/components/ui/CreateMapModal.tsx`, `Toolbar.tsx`, `mapStore.ts` | 1.0d |
| Test (projection, dedup, quota, null-coords 503) | — | 0.5d |

**Total: ~2.5–3 days.** Low risk — insert path mirrors `/import`; the only genuinely
new bits are the coordinate seed and the projection.
