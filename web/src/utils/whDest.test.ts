import { describe, it, expect } from 'vitest';
import { leadsToFromSigName, isUnresolvedLeadsTo, leadsToClasses } from './whDest';

describe('leadsToFromSigName', () => {
  // A Drifter hole is the only one the scanner calls "Unidentified"; every
  // other unscanned hole is "Unstable Wormhole".
  it('reads an unidentified wormhole as leading to Drifter', () => {
    expect(leadsToFromSigName('Unidentified Wormhole')).toBe('Drifter');
  });

  it.each([
    'unidentified wormhole',
    'UNIDENTIFIED WORMHOLE',
    'Unidentified  Wormhole',
  ])('is not fussy about "%s"', (name) => {
    expect(leadsToFromSigName(name)).toBe('Drifter');
  });

  it.each([
    'Unstable Wormhole',
    'Wormhole',
    'Lesser Sansha Covert Research Facility',
    'Unidentified Structure',
    '',
  ])('implies nothing for "%s"', (name) => {
    expect(leadsToFromSigName(name)).toBe('');
  });
});

// The leads-to picker offers bands (C1-C3, C4-C5), exact classes (C1..C6) and
// K-space. Every one of those tokens has to be understood here, because the
// two functions below are what decide whether a hole is still "undived".
//
// This is the contract that breaks quietly: a token the resolver does not know
// falls through to "a specific connected system name", so the hole would be
// treated as already solved and drop out of the undived list -- no error, just
// a wormhole nobody goes back to.
describe('leads-to tokens offered by the picker', () => {
  const BANDS  = ['C1-C3', 'C4-C5'];
  const EXACT  = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
  const OTHER  = ['C13', 'Thera', 'Pochven', 'Drifter', 'HS', 'LS', 'NS'];

  it('treats every offered token as unresolved, not as a pinned system', () => {
    for (const v of [...BANDS, ...EXACT, ...OTHER]) {
      expect(isUnresolvedLeadsTo(v)).toBe(true);
    }
  });

  it('resolves an exact class to exactly that class', () => {
    expect(leadsToClasses('C2')).toEqual(['C2']);
    expect(leadsToClasses('C5')).toEqual(['C5']);
    // and is case-insensitive, like every other consumer
    expect(leadsToClasses('c2')).toEqual(['C2']);
  });

  it('still expands the bands, so old data keeps matching', () => {
    expect(leadsToClasses('C1-C3')).toEqual(['C1', 'C2', 'C3']);
    expect(leadsToClasses('C4-C5')).toEqual(['C4', 'C5']);
  });

  it('a pinned system name is resolved, and names no class', () => {
    expect(isUnresolvedLeadsTo('J145359')).toBe(false);
    expect(leadsToClasses('J145359')).toEqual([]);
  });
});
