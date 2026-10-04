import { describe, it, expect } from 'vitest';
import { arrivedInPod } from './useLocationTracking';

const CAPSULE    = 670;
const GENOLUTION = 33328;   // the same pod, different type id
const DRAKE      = 24698;

// Reported: a map showed a wormhole connecting straight into Jita. The cause is
// a pod death — you die at a hole and wake in a brand-new capsule at your
// medical clone, and the tracker read that as one jump.
//
// The existing clone-list check was meant to catch this, but it needs the ESI
// clones scope, and where that isn't granted it suppresses nothing. This rule
// needs no scope.
describe('arrivedInPod', () => {
  it('spots the pod death that drew the phantom connection', () => {
    // Flying a Drake at the hole, then a fresh capsule in Jita.
    expect(arrivedInPod(true, CAPSULE)).toBe(true);
  });

  it('counts the Genolution pod, which is the same event', () => {
    expect(arrivedInPod(true, GENOLUTION)).toBe(true);
  });

  it('leaves a pilot who is simply flying a pod alone', () => {
    // Pods go through wormholes all the time. Without a hull change this is
    // someone scouting in a capsule, and that connection is real.
    expect(arrivedInPod(false, CAPSULE)).toBe(false);
  });

  it('leaves an ordinary ship swap alone', () => {
    // Reshipping is a hull change, but you are still flying.
    expect(arrivedInPod(true, DRAKE)).toBe(false);
  });

  it('does nothing when ESI gave us no ship', () => {
    // Suppressing on missing data would silently drop real connections.
    expect(arrivedInPod(true, null)).toBe(false);
    expect(arrivedInPod(true, undefined)).toBe(false);
  });

  it('is not fooled by the Capsule SKINs that share the name', () => {
    // The SDE has dozens of "Capsule ..." rows; all but two are SKINs, not
    // hulls, which is why this matches on type id rather than on the name.
    for (const skin of [41579, 45482, 54744, 94187]) {
      expect(arrivedInPod(true, skin)).toBe(false);
    }
  });
});
