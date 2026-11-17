import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../config.js';
import { SCOPE } from '../utils/esiScopes.js';
import { optionalGroups, parseChosenGroups, requestedScopes, scopeOptions } from './ssoScopes.js';

type Mutable = { ssoScopesMode: 'all' | 'choice'; ssoOptionalGroups: string[] | null; cloneScope: boolean };
const cfg = config as unknown as Mutable;
const saved = { ...cfg };

function setup(mode: 'all' | 'choice', optional: string[] | null = null, clones = false) {
  cfg.ssoScopesMode = mode;
  cfg.ssoOptionalGroups = optional;
  cfg.cloneScope = clones;
}

afterEach(() => { Object.assign(cfg, saved); });

// What every login asked for before the picker existed, minus the corporation
// membership scope that nothing ever used.
const TODAY = [
  SCOPE.location, SCOPE.online, SCOPE.ship, SCOPE.waypoint, SCOPE.openWindow,
  SCOPE.universeStructures, SCOPE.corpStructures, SCOPE.corpRoles,
  SCOPE.charContacts, SCOPE.corpContacts, SCOPE.allianceContacts, SCOPE.fleet,
];

describe('all mode (the default)', () => {
  it('asks for exactly what logins asked for before, whatever the request says', () => {
    setup('all');
    expect(new Set(requestedScopes(null))).toEqual(new Set(TODAY));
    expect(new Set(requestedScopes(['ship']))).toEqual(new Set(TODAY));
    expect(optionalGroups().size).toBe(0);
    expect(scopeOptions().groups.every((g) => !g.optional)).toBe(true);
  });

  it('adds clones only where the deployment enabled it', () => {
    setup('all', null, true);
    expect(requestedScopes(null)).toContain(SCOPE.clones);
    setup('all', null, false);
    expect(requestedScopes(null)).not.toContain(SCOPE.clones);
    expect(scopeOptions().groups.map((g) => g.id)).not.toContain('clones');
  });

  it('never asks for corporation membership any more', () => {
    setup('all', null, true);
    expect(requestedScopes(null)).not.toContain('esi-corporations.read_corporation_membership.v1');
  });
});

describe('choice mode', () => {
  it('location is always asked for, and the ticked groups are added', () => {
    setup('choice');
    const s = requestedScopes(['waypoints']);
    expect(s).toEqual(expect.arrayContaining([SCOPE.location, SCOPE.online, SCOPE.waypoint, SCOPE.openWindow]));
    expect(s).not.toContain(SCOPE.ship);
    expect(s).not.toContain(SCOPE.charContacts);
  });

  it('nothing ticked is location (plus the ungrouped invite mail) only', () => {
    setup('choice');
    expect(new Set(requestedScopes([]))).toEqual(new Set([SCOPE.location, SCOPE.online, SCOPE.openWindow]));
  });

  it('no choice sent means everything, the same as all ticked', () => {
    setup('choice');
    expect(new Set(requestedScopes(null))).toEqual(new Set(TODAY));
  });

  it('a group the operator did not list as optional is always asked for', () => {
    setup('choice', ['fleet', 'ship']);
    const s = requestedScopes([]);
    expect(s).toEqual(expect.arrayContaining([SCOPE.corpContacts, SCOPE.waypoint, SCOPE.charContacts]));
    expect(s).not.toContain(SCOPE.fleet);
    expect(s).not.toContain(SCOPE.ship);
    const opts = scopeOptions();
    expect(opts.mode).toBe('choice');
    expect(opts.groups.filter((g) => g.optional).map((g) => g.id).sort()).toEqual(['fleet', 'ship']);
  });

  it('location can never be made optional', () => {
    setup('choice', ['location', 'fleet']);
    expect(optionalGroups().has('location')).toBe(false);
    expect(requestedScopes([])).toContain(SCOPE.location);
  });
});

describe('parseChosenGroups', () => {
  it('reads the ticked groups and drops anything unknown', () => {
    expect(parseChosenGroups('ship, waypoints,bogus,')).toEqual(['ship', 'waypoints']);
    expect(parseChosenGroups('')).toEqual([]);
    expect(parseChosenGroups(undefined)).toBeNull();
    expect(parseChosenGroups(['ship'])).toBeNull();
  });
});
