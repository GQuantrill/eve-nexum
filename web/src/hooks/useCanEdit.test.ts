import { describe, it, expect } from 'vitest';
import { contributorMayTrack } from './useCanEdit';

// Reported: a contributor flew a chain and none of it went on the map, and the
// map didn't show them where they were. The server has let contributors record
// their own movement since the role was added, but the tracker asked "can this
// user edit the layout?", which a contributor never can, so it never tried.
describe('contributorMayTrack', () => {
  it('lets a contributor record where they fly', () => {
    expect(contributorMayTrack('contributor', false, 'corp', undefined)).toBe(true);
  });

  it('does so on a share they can write to', () => {
    expect(contributorMayTrack('contributor', false, 'shared', true)).toBe(true);
  });

  it('stops at a locked map', () => {
    expect(contributorMayTrack('contributor', true, 'corp', undefined)).toBe(false);
  });

  it('stops at a view-only share', () => {
    expect(contributorMayTrack('contributor', false, 'shared', false)).toBe(false);
  });

  it('gives a read-only user nothing', () => {
    expect(contributorMayTrack('readonly', false, 'corp', undefined)).toBe(false);
  });
});
