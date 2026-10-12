import { describe, it, expect } from 'vitest';
import { arrivedInPod, cloneJumpedBetween } from './useLocationTracking';

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

// ── Clone jumps ───────────────────────────────────────────────────────────────
// Reported: a wormhole drawn out of a home system that has none, caused by a
// clone jump to a staging system. Three guards were in place and none could
// fire, because a clone jump is capsule to capsule — the hull does not change,
// and BOTH the clone-list check and the pod check were `hullChanged && ...`.
// Granting the ESI clones scope would not have helped; the dead half was the
// hull. What a clone jump does need is a station or structure at each end.
describe('cloneJumpedBetween', () => {
  it('spots the clone jump that drew the phantom connection', () => {
    expect(cloneJumpedBetween(true, true)).toBe(true);
  });

  it('leaves a hole jumped between two points in space alone', () => {
    expect(cloneJumpedBetween(false, false)).toBe(false);
  });

  it('leaves a pilot who undocked and flew somewhere alone', () => {
    // Docked, then in space elsewhere: they undocked and flew it.
    expect(cloneJumpedBetween(true, false)).toBe(false);
  });

  it('leaves a pilot who flew somewhere and docked alone', () => {
    // In space, then docked elsewhere — the ordinary "exit the chain and dock
    // at the trade hub" move. Suppressing this would lose the exit connection,
    // which is the one people most want recorded.
    expect(cloneJumpedBetween(false, true)).toBe(false);
  });

  it('does not depend on the hull, which a clone jump never changes', () => {
    // The whole point: this is decided without reference to the ship, so
    // capsule-to-capsule no longer slips through.
    expect(cloneJumpedBetween(true, true)).toBe(true);
    expect(arrivedInPod(false, CAPSULE)).toBe(false);
  });
});
