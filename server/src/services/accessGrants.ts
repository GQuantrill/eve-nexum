// Login allow-list (access_grants) helpers. The single login gate in
// routes/auth.ts calls isLoginPermitted(); the admin grant endpoints and (later)
// the standings auto-admit call standingPermitsTarget() to enforce the
// positive-standing prerequisite from access-control-design.md section 4.0.
import { db } from '../db.js';
import { config } from '../config.js';
import { getStandingsLoginSettings } from './appSettings.js';

export type GrantKind = 'corp' | 'alliance' | 'character';

// The login gate: is this character admitted by any allow-list grant — their
// own character id, their corp, or (only when they have one) their alliance?
export async function isLoginPermitted(p: {
  characterId: number;
  corpId:      number | null;
  allianceId:  number | null;
}): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM access_grants
        WHERE (kind = 'character' AND eve_id = $1)
           OR ($2::bigint IS NOT NULL AND kind = 'corp'     AND eve_id = $2)
           OR ($3::bigint IS NOT NULL AND kind = 'alliance' AND eve_id = $3)
     ) AS ok`,
    [p.characterId, p.corpId, p.allianceId],
  );
  return rows[0]?.ok ?? false;
}

// Positive-standing prerequisite (design 4.0). Does the DEPLOYMENT hold `eveId`
// (of `kind`) at positive standing (> 0)? Install-type decides WHOSE contacts:
//   - Alliance install: the deployment ALLIANCE's contacts (contact_kind matches
//     the target: alliance / corporation / character).
//   - Corp install: the deployment CORP's own contacts. A corp can hold a
//     standing toward an alliance, so an alliance target is checked against the
//     corp's alliance contact (not refused).
// Signed comparison `standing > 0` — never magnitude/abs. Fail-closed: no
// matching contact row (or contacts never synced) returns false.
export async function standingPermitsTarget(kind: GrantKind, eveId: number): Promise<boolean> {
  if (config.allianceMode) {
    const contactKind =
      kind === 'alliance' ? 'alliance' :
      kind === 'corp'     ? 'corporation' :
                            'character';
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM alliance_standings
          WHERE alliance_id = ANY($1::bigint[])
            AND contact_kind = $2 AND contact_id = $3 AND standing > 0
       ) AS ok`,
      [config.allianceIds, contactKind, eveId],
    );
    return rows[0]?.ok ?? false;
  }

  // Corp install: the deployment corp's own contacts. A corp can hold a standing
  // toward an alliance, so an alliance target is checked against the corp's
  // alliance contact (gated on the corp's own standing) rather than refused.
  const contactKind =
    kind === 'corp'      ? 'corporation' :
    kind === 'alliance'  ? 'alliance' :
                           'character';
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM corp_standings
        WHERE corp_id = ANY($1::bigint[])
          AND contact_kind = $2 AND contact_id = $3 AND standing > 0
     ) AS ok`,
    [config.corpIds, contactKind, eveId],
  );
  return rows[0]?.ok ?? false;
}

// Alliance targets are allowed in ANY restricted deployment. Even a corp install
// can admit an alliance — gated on the corp's OWN standing toward that alliance
// (a corp's contact list can hold alliance standings). Solo installs gate
// nothing, so this is only consulted in restricted mode. Shared by the admin
// grant endpoint and the map-share flow.
export function grantKindAllowedForInstall(kind: GrantKind): boolean {
  if (kind === 'alliance') return config.corpMode || config.allianceMode;
  return true;
}

// Standings auto-admit ("friends") — Phase 3. Admin-toggleable, OFF by default.
// When on, a pilot may log in if the DEPLOYMENT holds them at standing >= the
// admin-chosen threshold (5 or 10), even without an explicit access_grants row.
// Install-type decides the source (per design):
//   - Alliance install: the deployment ALLIANCE's contacts only; match the
//     pilot's alliance, then corp, then character. Corp standings are ignored.
//   - Corp install: the deployment CORP's own contacts; match the pilot's corp,
//     character, OR alliance (a corp can hold an alliance standing).
// POSITIVE-ONLY: signed `standing >= threshold` (threshold is 5 or 10), never
// magnitude/abs. Fail-closed: disabled, or no matching contact, returns false.
export async function standingsPermitLogin(p: {
  characterId: number;
  corpId:      number | null;
  allianceId:  number | null;
}): Promise<boolean> {
  const { enabled, threshold } = await getStandingsLoginSettings();
  if (!enabled) return false;

  if (config.allianceMode) {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM alliance_standings
          WHERE alliance_id = ANY($1::bigint[])
            AND standing >= $2
            AND ( (contact_kind = 'alliance'    AND contact_id = $3)
               OR (contact_kind = 'corporation' AND contact_id = $4)
               OR (contact_kind = 'character'   AND contact_id = $5) )
       ) AS ok`,
      [config.allianceIds, threshold, p.allianceId, p.corpId, p.characterId],
    );
    return rows[0]?.ok ?? false;
  }

  // Corp install: the deployment corp's own contacts. Match the pilot's corp,
  // character, OR alliance — a corp's contact list can hold an alliance standing,
  // so a corp deployment can admit a whole friendly alliance.
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM corp_standings
        WHERE corp_id = ANY($1::bigint[])
          AND standing >= $2
          AND ( (contact_kind = 'corporation' AND contact_id = $3)
             OR (contact_kind = 'character'   AND contact_id = $4)
             OR ($5::int IS NOT NULL AND contact_kind = 'alliance' AND contact_id = $5) )
     ) AS ok`,
    [config.corpIds, threshold, p.corpId, p.characterId, p.allianceId],
  );
  return rows[0]?.ok ?? false;
}

// The positive-standing prerequisite (design 4.0) applies to GROUP targets
// (corp / alliance) only. An individual character is a deliberate, named 1:1
// grant — the operator is explicitly picking a specific person, not admitting a
// whole org — so it isn't gated on standing (you rarely set per-character
// standings in-game anyway). Used by both the map-share flow and the admin
// allow-list add so they stay consistent.
export function requiresPositiveStanding(kind: GrantKind): boolean {
  return kind !== 'character';
}

// Remove login grants that only ever existed BECAUSE the deployment held a
// corp/alliance at positive standing — i.e. source 'share' (created by a map
// share's "also grant login") or 'standing' — once that standing no longer
// holds. This is what stops a guest corp, admitted via standings, from
// grandfathering itself into PERMANENT access by having a member share a map:
// the grant is now conditional on the standing that justified it.
//
// Deliberately NEVER touches:
//   • source 'env' / 'admin' — operator/admin decisions, an intentional static
//     allow-list; they outlive standings on purpose.
//   • kind 'character' — a named 1:1 grant, never standing-gated (mirrors
//     requiresPositiveStanding), so it has no standing to lose.
//
// FAIL-SAFE: prune only when this deployment's contacts have actually been
// synced (the relevant standings table has ≥1 row for the configured org). An
// empty/never-synced table must not be read as "everyone lost standing" and
// wipe every share grant. Mirrors the ESI-outage fail-safe in the sweep.
// Returns the number of grants pruned.
export async function pruneStandingDerivedGrants(): Promise<number> {
  if (!config.restrictedMode) return 0;

  if (config.allianceMode) {
    const { rowCount } = await db.query(
      `DELETE FROM access_grants ag
        WHERE ag.source IN ('share','standing')
          AND ag.kind   IN ('corp','alliance')
          AND EXISTS (SELECT 1 FROM alliance_standings WHERE alliance_id = ANY($1::bigint[]))
          AND NOT EXISTS (
            SELECT 1 FROM alliance_standings s
             WHERE s.alliance_id  = ANY($1::bigint[])
               AND s.contact_kind = CASE ag.kind WHEN 'corp' THEN 'corporation' ELSE 'alliance' END
               AND s.contact_id   = ag.eve_id
               AND s.standing     > 0
          )`,
      [config.allianceIds],
    );
    return rowCount ?? 0;
  }

  // Corp install: the deployment corp's own contacts. A corp can hold a standing
  // toward an alliance, so an alliance grant is checked against the corp's
  // alliance contact — matching standingPermitsTarget's corp branch exactly.
  const { rowCount } = await db.query(
    `DELETE FROM access_grants ag
      WHERE ag.source IN ('share','standing')
        AND ag.kind   IN ('corp','alliance')
        AND EXISTS (SELECT 1 FROM corp_standings WHERE corp_id = ANY($1::bigint[]))
        AND NOT EXISTS (
          SELECT 1 FROM corp_standings s
           WHERE s.corp_id      = ANY($1::bigint[])
             AND s.contact_kind = CASE ag.kind WHEN 'corp' THEN 'corporation' ELSE 'alliance' END
             AND s.contact_id   = ag.eve_id
             AND s.standing     > 0
        )`,
    [config.corpIds],
  );
  return rowCount ?? 0;
}
