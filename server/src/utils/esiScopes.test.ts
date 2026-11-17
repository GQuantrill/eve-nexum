import { describe, it, expect } from 'vitest';
import { SCOPE, hasScope, missingScopes, scopesFromAccessToken } from './esiScopes.js';

const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('scopesFromAccessToken', () => {
  it('reads a list of scopes', () => {
    expect(scopesFromAccessToken(jwt({ scp: [SCOPE.location, SCOPE.online] })))
      .toEqual([SCOPE.location, SCOPE.online]);
  });
  it('reads a single scope (EVE sends a bare string when there is one)', () => {
    expect(scopesFromAccessToken(jwt({ scp: SCOPE.fleet }))).toEqual([SCOPE.fleet]);
  });
  it('reads no scopes as an empty list', () => {
    expect(scopesFromAccessToken(jwt({ sub: 'CHARACTER:EVE:1' }))).toEqual([]);
  });
  it('gives null for a token it cannot read, so the stored list is kept', () => {
    expect(scopesFromAccessToken('not-a-jwt')).toBeNull();
    expect(scopesFromAccessToken(jwt({ scp: 42 }))).toBeNull();
  });
});

describe('hasScope / missingScopes', () => {
  it('treats a list not recorded yet as holding everything', () => {
    expect(hasScope(null, SCOPE.fleet)).toBe(true);
    expect(missingScopes(undefined, [SCOPE.fleet, SCOPE.waypoint])).toEqual([]);
  });
  it('reports exactly what a recorded list lacks', () => {
    const granted = [SCOPE.location, SCOPE.online];
    expect(hasScope(granted, SCOPE.location)).toBe(true);
    expect(hasScope(granted, SCOPE.fleet)).toBe(false);
    expect(missingScopes(granted, [SCOPE.online, SCOPE.fleet, SCOPE.waypoint]))
      .toEqual([SCOPE.fleet, SCOPE.waypoint]);
  });
  it('an empty recorded list holds nothing', () => {
    expect(hasScope([], SCOPE.location)).toBe(false);
  });
});
