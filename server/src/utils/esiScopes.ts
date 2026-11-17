// The ESI scopes nexum uses, by what they unlock. A character's granted list is
// read from its access token (the JWT `scp` claim) at login and at every
// refresh, and stored on users.esi_scopes.
//
// NULL there means "not recorded yet": a character whose token hasn't been
// refreshed since this shipped. It is treated as holding every scope, which is
// what nexum assumed before scopes were recorded at all, so nobody loses a
// feature while their list fills in.
export const SCOPE = {
  location:           'esi-location.read_location.v1',
  online:             'esi-location.read_online.v1',
  ship:               'esi-location.read_ship_type.v1',
  waypoint:           'esi-ui.write_waypoint.v1',
  openWindow:         'esi-ui.open_window.v1',
  universeStructures: 'esi-universe.read_structures.v1',
  corpStructures:     'esi-corporations.read_structures.v1',
  corpRoles:          'esi-characters.read_corporation_roles.v1',
  charContacts:       'esi-characters.read_contacts.v1',
  corpContacts:       'esi-corporations.read_contacts.v1',
  allianceContacts:   'esi-alliances.read_contacts.v1',
  fleet:              'esi-fleets.read_fleet.v1',
  clones:             'esi-clones.read_clones.v1',
} as const;

export type EsiScope = typeof SCOPE[keyof typeof SCOPE];

// The scopes an EVE SSO v2 access token was issued with, or null when the
// token can't be read (keep whatever was recorded before).
export function scopesFromAccessToken(token: string): string[] | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { scp?: unknown };
    if (Array.isArray(claims.scp)) return claims.scp.filter((s): s is string => typeof s === 'string');
    if (typeof claims.scp === 'string') return [claims.scp];
    return claims.scp == null ? [] : null;
  } catch {
    return null;
  }
}

// Whether a character holds a scope. Null (not recorded yet) counts as yes.
export function hasScope(granted: readonly string[] | null | undefined, scope: EsiScope): boolean {
  return granted == null || granted.includes(scope);
}

// The required scopes a character lacks; empty when it has them all.
export function missingScopes(
  granted: readonly string[] | null | undefined,
  required: readonly EsiScope[],
): EsiScope[] {
  return required.filter((s) => !hasScope(granted, s));
}

// The groups a pilot chooses between, by what they power. Location is always
// required: tracking is what nexum is for. Everything else can be optional (see
// services/ssoScopes.ts for which ones a deployment actually offers).
export const SCOPE_GROUP_IDS = [
  'location', 'ship', 'waypoints', 'standings', 'orgStandings', 'citadels', 'fleet', 'clones', 'director',
] as const;
export type ScopeGroupId = typeof SCOPE_GROUP_IDS[number];

export const SCOPE_GROUPS: Record<ScopeGroupId, readonly EsiScope[]> = {
  location:     [SCOPE.location, SCOPE.online],
  ship:         [SCOPE.ship],
  waypoints:    [SCOPE.waypoint],
  standings:    [SCOPE.charContacts],
  orgStandings: [SCOPE.corpContacts, SCOPE.allianceContacts],
  citadels:     [SCOPE.universeStructures],
  fleet:        [SCOPE.fleet],
  clones:       [SCOPE.clones],
  director:     [SCOPE.corpRoles, SCOPE.corpStructures],
};

export function isScopeGroupId(v: string): v is ScopeGroupId {
  return (SCOPE_GROUP_IDS as readonly string[]).includes(v);
}

// The groups a character holds in full. Null (not recorded yet) holds them all.
export function groupsHeld(granted: readonly string[] | null | undefined): ScopeGroupId[] {
  return SCOPE_GROUP_IDS.filter((g) => SCOPE_GROUPS[g].every((s) => hasScope(granted, s)));
}
