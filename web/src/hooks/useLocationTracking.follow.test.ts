import { describe, it, expect } from 'vitest';
import { isFollowedLocation } from './useLocationTracking';

// Reported: opening the app as the main (in Hek) and tracking an alt (in Tar)
// auto-added a Hek-Tar connection. The main's location lingered until the
// alt's first read, so the tracker took Hek as the alt's starting system and
// then Tar as a jump from it.
describe('isFollowedLocation', () => {
  const MAIN = 1, ALT = 2;
  it("ignores the previous character's location after a switch", () => {
    expect(isFollowedLocation(MAIN, ALT)).toBe(false);
  });
  it("uses the followed character's own location", () => {
    expect(isFollowedLocation(ALT, ALT)).toBe(true);
  });
  it('waits for the first read', () => {
    expect(isFollowedLocation(null, MAIN)).toBe(false);
  });
});
