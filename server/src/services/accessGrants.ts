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
// (of `kind`) at positive standing (> 0)? Install-type decides the source:
//   - Alliance install: the deployment ALLIANCE's contacts only (alliance takes
//     priority; corp standings are not consulted).
//   - Corp install: the deployment CORP's contacts only; alliance standings are
//     ignored entirely, so an alliance target can never qualify (alliance targets
//     are alliance-install-only by design).
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

  // Corp install: alliance-kind targets are not offered (return false); corp and
  // character targets check the deployment corp's contacts.
  const contactKind =
    kind === 'corp'      ? 'corporation' :
    kind === 'character' ? 'character' :
                           null;
  if (contactKind === null) return false;
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

// Alliance targets only make sense in an alliance installation (a corp install
// works purely at corp/character granularity and ignores alliance standings).
// Shared by the admin grant endpoint and the map-share flow.
export function grantKindAllowedForInstall(kind: GrantKind): boolean {
  if (kind === 'alliance') return config.allianceMode;
  return true;
}

// Standings auto-admit ("friends") — Phase 3. Admin-toggleable, OFF by default.
// When on, a pilot may log in if the DEPLOYMENT holds them at standing >= the
// admin-chosen threshold (5 or 10), even without an explicit access_grants row.
// Install-type decides the source (per design):
//   - Alliance install: the deployment ALLIANCE's contacts only; match the
//     pilot's alliance, then corp, then character. Corp standings are ignored.
//   - Corp install: the deployment CORP's contacts only; match the pilot's corp,
//     then character. Alliance standings are ignored entirely.
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

  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM corp_standings
        WHERE corp_id = ANY($1::bigint[])
          AND standing >= $2
          AND ( (contact_kind = 'corporation' AND contact_id = $3)
             OR (contact_kind = 'character'   AND contact_id = $4) )
     ) AS ok`,
    [config.corpIds, threshold, p.corpId, p.characterId],
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
