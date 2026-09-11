import { describe, it, expect } from 'vitest';
import { leadsToFromSigName } from './whDest';

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
