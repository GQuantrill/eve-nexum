# Wormhole jump-confirm: auto-populate leads-to

## Goal

When a tracked character jumps through a wormhole, let the user confirm which
signature they jumped, and populate that sig's `wh_leads_to` from the class of
the system they arrived in. Non-blocking, confirm-on-commit (never optimistic).

## Why confirm, not auto + undo

- "One *known* wormhole sig" != "one wormhole" — the real hole may be unmapped,
  so silently stapling leads-to onto the known sig can mis-attribute.
- Sig writes are not silent: `createSignature` / `updateSignature` always
  `publishToMap('sig.changed')` + `syncSignature` (live-sync to every client +
  cross-map), and setting a non-empty `whLeadsTo` fires `flushK162` → the held
  Discord notice goes out (`mapWrite.ts:47,81,85`; `maps.ts:1833`).
- So an optimistic write broadcasts (and may Discord-ping) wrong intel before
  anyone confirms. nexum already *holds* the K162 notice until leads-to is
  known — confirm-on-commit matches that existing philosophy.

## Trigger (all must hold)

1. A **tracked jump** A→B fired in `applyJump` (location tracking, jumper's
   client only — inherently per-client).
2. The jump is a **wormhole jump**. v1 detects this client-side as "the jump
   touches w-space" (`eveSystemId >= 31_000_000` on either end) — w-space has no
   stargates, so such a jump is necessarily through a hole. (k<->k wormhole
   jumps need the server's gate classification to separate from gate jumps —
   out of scope for v1.)
3. The same gate `applyJump` uses for auto-add: `canAdd = trackJumps &&
   !map.locked && canEdit`. Turning off jump tracking opts out of prompts too.
4. A has **>= 1 known wormhole signature** (`sig_type = 'wormhole'`) that could
   plausibly lead to the arrival (see candidate rule). Unknowns are never
   touched — per design. Fires on any qualifying jump, not just a new
   connection — a class-only hole still needs upgrading even on a known route.

If any fail: do nothing (silent). Never prompt on a gate jump or when there is
nothing fillable.

## Candidate selection

`wh_leads_to` (see `LeadsToDropdown`) can hold: blank/`unknown`, a class/band
(`C1-C3`, `C4-C5`, `C6`, `HS`, `Thera`, …), a legacy exact class (`C3`), or a
**specific connected-system name** (`J203753`).

- **Candidates = A's wormhole sigs (`sig_type = 'wormhole'`) that are NOT yet
  pinned to a system AND are class-compatible with the arrival.**
  - Pinned-to-a-system (value not in the class/band/unknown set) → excluded; we
    already know where it leads. This is the "solved" signal.
  - `isCandidate` = value in `CLASS_OR_UNKNOWN`, and (blank/`unknown`, or equals
    the arrival's band / legacy exact class). A hole pinned to a *different*
    class can't be the one jumped → excluded.
- Exactly one candidate → **pre-select it**; confirm is a single tap.
  Several → one button per candidate + an **"unmapped hole"** skip.

## What confirm writes

- Sets `wh_leads_to` to the **arrival system name** (`toName`, e.g. `J203753`) —
  the genuine upgrade from class → specific system, via the existing sig PATCH.
- Then calls `reevaluateConnectionsForSystem` (the same auto-detect the sig pane
  runs on edit), so the **map connection edge picks up this sig's WH type** now
  that the hole resolves to the destination system. Without this the leads-to is
  set but the edge stays unlabelled.

## UI: sticky actionable toast (not a modal, not the current toast)

The current toaster is text-only, auto-dismiss 3-7s, click-to-close
(`Toaster.tsx`). Extend it minimally:

- `toast.confirm({ msg, actions: {label, kind?, onClick}[], sticky: true })`
  - `actions`: renders a button row inside the toast.
  - `sticky`: no auto-dismiss; stays until an action is taken or it is
    explicitly closed. (Keep existing `error/info/success` unchanged.)
- Single (pre-selected) case:
  `Jumped to C4. Set ABC-123 -> C4?  [Confirm] [Different hole] [x]`
- Multiple case — **one button per eligible candidate, no cap**. Eligible =
  known wormhole sigs with unknown leads-to (solved holes are excluded), so if
  A has 8 unknown holes, show 8:
  `Which hole did you take into C4?  [ABC-123] [DEF-456] ... [Unmapped] [x]`
  Buttons wrap to multiple rows; in practice the eligible count is small
  because solved holes drop out.
- Guardrails: never auto-dismiss a pending decision; one prompt per jump;
  jumper-only; anchored to "the jump from A" so it stays valid if the user
  jumps onward before answering.

## Write-on-commit

On the user's pick, write through the **existing** endpoint so sync + Discord
behave normally — just with confirmed data:

`PATCH /api/maps/:mapId/systems/:systemId/signatures/:sigId` with
`{ whLeadsTo: B.systemClass }` (same call as `SignaturePane.tsx:377`).

Nothing is written (no live-sync, no Discord) until they confirm. "Unmapped" /
dismiss writes nothing. Manual entry via SignaturePane remains the fallback.

## Edge cases

- Poll latency (~10s): the prompt references A + the sig, so it survives the
  user moving on; the write targets A's sig regardless of current location.
- Re-render safety: dedupe by (jumpFromSystemId, arrivalEveSystemId) so React
  re-renders don't re-toast the same jump.
- leads-to already set on the sole candidate → no prompt.
- Readonly / locked map / no-track → no prompt (same gate as auto-add).
- Reverse side (optional, later): also offer to drop the K162 on B leading to
  A's class. Out of scope for v1.

## Files

- `web/src/components/ui/Toaster.tsx` — actions + sticky support.
- `web/src/App.css` — toast action-button styling.
- `web/src/hooks/useLocationTracking.ts` (`applyJump`) — detect non-gate jump,
  fetch A's sigs (`GET /api/maps/:mapId/systems/:systemId/signatures`), narrow,
  raise the confirm toast.
- (maybe) `web/src/hooks/useWhJumpConfirm.ts` — extract the candidate/narrow
  logic so `applyJump` stays lean and it's unit-testable.
- `web/src/i18n/locales/*/common.json` — new strings in all 9 locales
  (parity-checked).

## Out of scope (v1)

- Touching unknown/unscanned sigs.
- Writing `wh_type` (the code still needs scanning — only leads-to is inferable).
- Reverse-side K162 auto-drop.
- Capital-jump / filament inference.
