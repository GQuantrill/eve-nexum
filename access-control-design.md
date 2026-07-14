# Access-control redesign: DB-backed login grants

Status: DRAFT for review (2026-07-14). Owner: gq@area404.org.

Goal: stop basing "who may log in" solely on the `.env` corp/alliance lists, so
operators can admit friendly corps/alliances (and individuals) from the admin
area without editing `.env` and restarting the server.

This is a security-boundary change on a live deployment. Ship it in phases, each
on its own branch, with a focused review (CodeQL is enabled and will not catch
authz logic bugs -- these need tests).

--------------------------------------------------------------------------------

## 1. How it works today

Login is gated by a single check in the SSO callback,
`server/src/routes/auth.ts:179-184`:

```
corpPermitted     = config.corpIds.includes(userCorpId)          // from CORP_ID
alliancePermitted = config.allianceIds.includes(userAllianceId)  // from ALLIANCE_ID
if (config.restrictedMode && !corpPermitted && !alliancePermitted)
    reject (redirect to failUrl('not_in_corp'))
```

`config.restrictedMode` (`config.ts:126`) = "any CORP_ID or ALLIANCE_ID is set".
It also drives role enforcement, map scoping, and the idle-map sweep, so it must
keep meaning "this is a private deployment".

Two distinct concepts that must stay separate:

- **Login gate** - may this character get a session at all. (The `.env` list.)
- **Map visibility / write** - what a logged-in user can see and edit. Handled
  separately in `server/src/routes/share.ts` via `AccessKind =
  'owner' | 'corp_member' | 'alliance_member' | 'shared'`.

The problem in one sentence: sharing a map to a corp (`map_shares`) grants
*visibility* but the login gate still rejects that corp's members, so they never
reach the map.

## 2. What already exists (reused, not rebuilt)

- `map_shares` (`migrate.ts:679`) - per-map grants to a **character or corp** by
  raw EVE id (survives the recipient never having logged in). No alliance target.
- Standings tables (`migrate.ts:613-640`): `character_standings`,
  `corp_standings`, `alliance_standings`. Keyed `(owner_id, contact_kind,
  contact_id) -> standing`, `contact_kind IN ('character','corporation','alliance')`.
  Refreshed on login via `refreshStandingsForUser`.
- Admin corp lookup by name + ticker with caching (`admin.ts:36-105`) and the
  `entity_names` cache (`migrate.ts:664`).
- Admin user management: list / change-role / block / unblock / recheck-corp
  (`admin.ts` routes `/users`, `/users/:id/role`, `/users/:id/block`, ...).
- `users.blocked`, role tiers (`alliance_admin | admin | full | edit | readonly`),
  and the owner/account model.

The gap: the login gate consults none of these.

## 3. Goals / non-goals

Goals:
- Admit friendly corps / alliances / individual characters without editing `.env`.
- Manage the allow-list from the admin area.
- Keep `.env` as the immutable "core" that admin cannot remove.
- Optionally auto-admit by in-game standings (friends at +5 or +10).
- Wire the existing share-to-corp flow so sharing can also grant login.

Non-goals (for this change):
- Changing map visibility semantics for the core corp/alliance.
- Moving `ADMIN_CHAR_ID` out of `.env`.
- Anything that lets a guest see maps that were not explicitly shared to them.

--------------------------------------------------------------------------------

## 4. Design

### 4.0 Positive-standing prerequisite (applies to EVERY grant path)

Hard rule (user, 2026-07-14): the system must NOT let a user share a map to, or
grant login for, any entity the deployment does not hold at POSITIVE standing.
This is not a Phase-3-only concern - it constrains ALL of:

- adding a corp/alliance/character to the login allow-list from admin (Phase 1),
- sharing a map to a corp/alliance/character (Phase 2), and
- the standings auto-admit (Phase 3).

"Positive" means the deployment's effective standing toward the target is `> 0`
(neutral 0 and negative -5/-10 are blocked). The standing source follows the
install type: alliance install uses the alliance's contacts, corp install uses
the corp's contacts (see 4/Phase 3). The check is on the raw SIGNED effective
standing - never magnitude/abs (the killboard tint logic uses abs and must not be
reused here). Fail-closed: if the target has no standing entry, or the contact
list has never synced, treat it as "not positive" and refuse the grant.

Exemption: the deployment's OWN corp/alliance (the `.env`-seeded core) is exempt -
it is the deployment's own identity, not a grant to a third party.

Open sub-decisions to resolve in review (do not assume):
- Does a manual grant require only `> 0`, or the same `+5`/`+10` minimum the
  auto-admit uses? Draft assumes manual = any positive (`> 0`); auto-admit = the
  admin-chosen `+5`/`+10`.
- For a character-target grant, which standing decides it - the character's own,
  their corp's, their alliance's, or best matching? Draft assumes best matching
  contact (character, then corp, then alliance in alliance installs).
- Should a blocked (non-positive) target be hidden in the share/allow search, or
  shown greyed-out with a "standing too low" reason? (UX; recommend greyed-out +
  reason so the operator understands why.)

### Phase 1 - DB allow-list, seeded from `.env` (the core change)

New table:

```sql
CREATE TABLE IF NOT EXISTS access_grants (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT        NOT NULL CHECK (kind IN ('corp','alliance','character')),
  eve_id        INTEGER     NOT NULL,
  source        TEXT        NOT NULL DEFAULT 'admin'
                            CHECK (source IN ('env','admin','share','standing')),
  note          TEXT,
  added_by_user INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, eve_id)
);
```

Boot-time seed (idempotent, runs after migrate, like the Discord seed): upsert
every `CORP_ID` as `('corp', id, 'env')` and every `ALLIANCE_ID` as
`('alliance', id, 'env')`. `source='env'` rows are **immutable from admin** -
they can only change by editing `.env`. This keeps the operator's core
un-removable even by a compromised admin account, and means `.env` remains the
source of truth for the deployment identity.

Gate change (`auth.ts:179-184`) becomes:

```
permitted =
     access_grants has ('character', userCharacterId)
  OR access_grants has ('corp',      userCorpId)
  OR (userAllianceId != null AND access_grants has ('alliance', userAllianceId))
  OR standingsPermit(userCorpId, userAllianceId, userCharacterId)   // Phase 3
if (config.restrictedMode && !permitted) reject
```

`config.corpIds` / `config.allianceIds` are no longer read at the gate - they
only feed the seed. `restrictedMode` stays defined by `.env` (a deployment with
no CORP_ID/ALLIANCE_ID is still wide-open solo mode; you do not get to turn a
solo install restricted purely from the DB).

Admin surface (new): `GET/POST/DELETE /api/admin/access-grants`. List shows
kind, resolved name+ticker (via existing lookup), source, who added it, when.
`source='env'` rows are read-only in the UI. Reuse the corp/alliance search that
map-sharing already uses. The POST MUST enforce the positive-standing gate (4.0):
adding a non-env grant is refused unless the deployment holds the target at
positive standing (the `.env` core is exempt). Server-side check, not just UI.

### Phase 2 - share-to-corp/alliance can also grant login

- Add `target_alliance_id` to `map_shares`; the XOR CHECK becomes "exactly one
  of character/corp/alliance is non-null". Update `share.ts` visibility to match
  an alliance target, and the create endpoint (`maps.ts` `POST /shares`).
- Positive-standing gate on the share itself (per 4.0): the create endpoint MUST
  reject a share to any target the deployment does not hold at positive standing,
  and the picker must not offer such targets (or shows them disabled with the
  reason). This applies even though the operator is choosing the target by hand -
  a manual mistake (or a stolen session) must not be able to hand a map to a
  hostile/neutral corp.
- When sharing a map to a corp/alliance that is **not** already in
  `access_grants`, the client prompts: "They cannot log in yet - also allow their
  members to sign in?" If accepted, insert an `access_grants` row with
  `source='share'`. That login grant is subject to the SAME positive-standing gate
  (4.0), so it can only be offered when the target is already positively stood.
- "Share to many": accept a list so an operator does not search 40 corps one at
  a time. Purely additive on top of the single-target endpoint.

### Phase 3 - standings-based auto-admit ("friends")

Admin-toggleable, **off by default**. Two settings, deployment-level, stored in a
small `app_settings` row (or reuse an existing settings mechanism):

- `standings_login_enabled` (bool)
- `standings_login_threshold` - the operator's chosen MINIMUM friendly level,
  constrained to exactly `+5` or `+10`. The admin UI presents it as a two-way
  choice of the lowest standing that may log in:
    - "+10 only" (Excellent)        -> threshold 10, admits only +10
    - "+5 and above" (Good or better) -> threshold 5, admits +5 AND +10
  It is a minimum, so the levels are INCLUSIVE upward: choosing +5 necessarily
  includes +10 (a +10 contact is "at or above" +5). You never admit +5 while
  excluding +10 - that combination is not offered. The API accepts only 5 or 10;
  there is no negative or zero option.

POSITIVE-ONLY (hard requirement): access is granted only to POSITIVE standings at
or above the threshold. Neutral (0) and all negative standings (-5, -10) are
always denied. The comparison is on the raw SIGNED effective standing:
`standing >= threshold` where threshold is 5.0 or 10.0. Do NOT reuse the killboard
tinting logic, which picks the standing of greatest MAGNITUDE (abs value) - that
would treat -10 as "most extreme" and could admit a hostile. The login gate uses
signed value only, never abs.

Evaluation depends on installation type (per your rule):

- **Alliance installation** (`config.allianceMode`): use the deployment
  alliance's contacts only. Permit if, for any deployment alliance id A,
  `alliance_standings(owner=A, contact matches the pilot) >= threshold`, where
  "contact matches" tries the pilot's alliance_id, then corp_id, then
  character_id. Alliance standings take priority; corp-level standings are not
  consulted.
- **Corp installation** (`config.corpMode` and not alliance): use the deployment
  corp's contacts only. Permit if, for any deployment corp id C,
  `corp_standings(owner=C, contact matches the pilot) >= threshold`, matching the
  pilot's corp_id then character_id. Alliance standings are ignored entirely.

Notes / caveats specific to standings:
- Positive only (repeat of the hard rule above, because it is easy to get wrong):
  threshold is +5 or +10, comparison is signed `standing >= threshold`, so 0 and
  negatives never admit. No abs/magnitude.
- The deployment corp/alliance contact list only exists in `*_standings` if a
  member with the ESI contacts scope + in-game roles has logged in and synced it.
  If it has never synced, the standings gate admits nobody (fail-closed) - that
  is the safe default, but the admin UI should surface "contacts not yet synced".
- Standings drift: a pilot dropped below threshold silently loses future login.
  Existing sessions are handled by the revocation rule (section 5).
- Effective `standing` is a REAL; compare `>= threshold` (5.0 or 10.0).

--------------------------------------------------------------------------------

## 5. Security invariants (the part that matters most)

1. **`.env` seeds are immutable from admin.** `source='env'` rows cannot be
   deleted or edited via the API. Guards against an admin (or a stolen admin
   session) locking out the core or opening the instance.
2. **`ADMIN_CHAR_ID` stays `.env`-only** - the bootstrap/safety hatch is never
   DB-controlled.
3. **Login != visibility.** A newly-admitted guest defaults to `readonly` and
   sees nothing until a map is explicitly shared to them. Before shipping,
   re-verify `share.ts` scoping: an admitted guest-corp must NOT gain
   `corp_member` access to the CORE corp's maps. This is the single most
   important review item - test it explicitly (guest corp X logs in, sees only
   maps shared to X, not the core corp's corp-maps unless CORP_MAP_SHARED).
4. **Revocation invalidates access.** Removing a grant should stop future logins
   AND drop existing sessions for affected users. Options: (a) mark affected
   `users` rows and check on each request, or (b) a session-version bump. At
   minimum, a revoked user is blocked at the next request, not only at next
   login. Decide and test.
5. **Periodic re-validation.** Corp/alliance membership is captured at login and
   stored on `users.corp_id/alliance_id`. People change corps in EVE. Extend the
   existing `recheck-corp` path to also re-evaluate against `access_grants` /
   standings, and/or re-check on a schedule.
6. **Audit.** Every grant add/remove goes to `admin_audit` (table exists), with
   actor + target + source.
7. **Fail-closed everywhere.** ESI hiccup during the corp/alliance lookup already
   rejects in restricted mode (`auth.ts:166-190`); keep that. A standings query
   error must deny, not admit.
8. **Positive standing is required to grant ANY access (see 4.0).** No manual map
   share, no manual login allow-list add, and no standings auto-admit may target
   an entity the deployment does not hold at positive standing (`> 0`). Neutral
   (0) and negative never qualify. Signed comparison only, never magnitude/abs
   (the killboard tint logic uses abs - do not reuse it here). Enforced
   server-side on every grant endpoint, not just in the UI. The `.env` core is the
   only exemption (it is the deployment's own identity). Fail-closed when no
   standing entry exists.

--------------------------------------------------------------------------------

## 6. Migration & rollout

- Additive migration only (new table, new column on `map_shares`, settings row).
  No destructive change; existing `.env`-gated deployments keep working because
  the boot seed reproduces today's allow-list exactly.
- Backwards compatible: with no admin grants and standings off, behaviour is
  identical to today.
- Rollout order: Phase 1 (branch + review + QA), then Phase 2, then Phase 3.
  Each is independently shippable.

Documentation (required, not optional): `README.md` currently describes access
as `.env`-only (CORP_ID / ALLIANCE_ID gate who may log in). Each phase must update
it so operators are not misled:
  - Phase 1: explain that `.env` CORP_ID/ALLIANCE_ID now SEEDS the allow-list (the
    immutable "core"), and that additional corps/alliances/characters are managed
    live from the admin area without editing `.env` or restarting. Clarify env
    rows cannot be removed from admin, and ADMIN_CHAR_ID stays env-only.
  - Phase 2: document share-to-corp/alliance also granting login (the prompt), and
    the new alliance map-share target.
  - Phase 3: document the standings auto-admit - install-type behaviour (alliance
    install uses alliance standings, corp install uses corp standings only), the
    +5/+10 minimum-level choice (inclusive upward), positive-only, off by default,
    and the "contacts must be synced by a director-role login first" caveat.
  Updating README is part of each phase's definition of done and should land in the
  same PR as the code, so the docs never lag the behaviour.

## 7. Test plan (authz cannot rely on tsc/CodeQL)

- Seed: CORP_ID/ALLIANCE_ID reproduce as `source='env'` grants; re-running boot
  is idempotent; env row not deletable via API (expect 4xx).
- Gate: char in an admin-added corp logs in; char in no listed/standing corp is
  rejected; individual-character grant works; alliance grant works.
- Isolation: admitted guest corp sees only maps shared to it; cannot see or write
  the core corp's maps; defaults to readonly.
- Revocation: after removing a grant, the user's next request is rejected and a
  fresh login fails.
- Standings, alliance install: +5/+10 threshold admits/denies correctly by
  alliance standing; corp standings ignored.
- Standings, corp install: admits/denies by corp standing; alliance standing
  ignored; empty contact list = deny.
- Positive-only (auto-admit): a pilot at -5 or -10 is DENIED at both thresholds; a
  pilot at 0 (neutral) is denied; +5 pilot admitted at threshold 5 but denied at
  threshold 10; +10 admitted at both. Explicitly assert no abs/magnitude path
  admits a negative.
- Positive-only (MANUAL grants, per 4.0): the `POST /shares` endpoint refuses a
  share to a corp/alliance/character held at 0 or negative standing (and to one
  with no standing entry) with a clear error; same for `POST
  /admin/access-grants`. Enforced server-side even if the client sends the request
  directly. A positively-stood target succeeds.
- Core exemption: sharing/granting the deployment's own env-seeded corp/alliance
  is never blocked by the standing check.
- ESI/standings error paths deny (fail-closed) for both auto and manual paths.

## 8. Open questions

- Sessions on revoke: per-request check vs session-version bump - pick one.
- Should a `character`-kind grant also implicitly allow that character's alts
  (owner/account model), or strictly per-character? Recommend per-character.
- Do we want a deployment-wide "share also grants login" default (auto) vs the
  per-share prompt? Recommend prompt, remember-per-session.
- Re-validation cadence for stale corp membership.
