import { describe, it, expect } from 'vitest';
import { sizeCapForClasses, smallerSize, exceedsSize, inferredSize } from './wormholeSize';
import { WH_CHART } from '../data/whTypeChart';

describe('the C1 size ceiling', () => {
  // The evidence for the rule, taken from our own chart rather than asserted.
  // If CCP ever puts a battleship-sized hole on a C1, this fails and the rule
  // below has to go with it.
  it('holds for every charted hole that touches a C1', () => {
    const touching = WH_CHART.filter((r) =>
      r.spawn_in.some((s) => s.startsWith('Class 1') && !s.startsWith('Class 12') && !s.startsWith('Class 13'))
      || r.leads_to.includes('C1'));

    expect(touching.length).toBeGreaterThan(20);        // the chart really was read
    const tooBig = touching.filter((r) =>
      r.ship_size !== 'up to Destroyer' && r.ship_size !== 'up to Battlecruiser');
    expect(tooBig.map((r) => `${r.wormhole} ${r.ship_size}`)).toEqual([]);
  });

  it('caps a hole with a C1 at either end, and nothing else', () => {
    expect(sizeCapForClasses('C1', 'HS')).toBe('medium');
    expect(sizeCapForClasses('HS', 'C1')).toBe('medium');
    expect(sizeCapForClasses('C1', 'C1')).toBe('medium');
    expect(sizeCapForClasses('C5', 'HS')).toBeNull();
    expect(sizeCapForClasses(null, undefined)).toBeNull();
  });

  it('only ever lowers a size, never raises one', () => {
    // E004 into a C1 is destroyer-sized, so "touches a C1" does not mean medium.
    // A scout who set small must keep small.
    expect(smallerSize('small', 'medium')).toBe('small');
    expect(smallerSize('large', 'medium')).toBe('medium');
    expect(smallerSize('xl', 'medium')).toBe('medium');
  });

  it('knows when a cap would actually change something', () => {
    expect(exceedsSize('large', 'medium')).toBe(true);     // the K162 default
    expect(exceedsSize('xl', 'medium')).toBe(true);
    expect(exceedsSize('medium', 'medium')).toBe(false);
    expect(exceedsSize('small', 'medium')).toBe(false);    // leave a scout's call alone
    expect(exceedsSize(null, 'medium')).toBe(false);
    expect(exceedsSize('nonsense', 'medium')).toBe(false);
  });
});

// The decision the connection panel actually applies. These are the branches
// that matter in the field: a K162 out of a C1 (the reported bug), and the
// several cases where the cap must NOT touch what somebody set by hand.
describe('inferredSize', () => {
  // N110 (HS, medium), B274 (HS, large), M001 (C1 static, medium).
  const whTypes = {
    N110: { maxJumpMass: 62_000_000 },
    B274: { maxJumpMass: 375_000_000 },
    M001: { maxJumpMass: 62_000_000 },
  };
  const call = (o: Partial<Parameters<typeof inferredSize>[0]>) =>
    inferredSize({ code: null, whTypes, currentSize: null, classA: null, classB: null, ...o });

  it('lowers a K162 into a C1 from the large default to medium', () => {
    expect(call({ code: 'K162', currentSize: 'large', classA: 'C1', classB: 'HS' })).toBe('medium');
    // and from either end
    expect(call({ code: 'K162', currentSize: 'large', classA: 'HS', classB: 'C1' })).toBe('medium');
  });

  it('leaves a K162 that is already within the cap alone', () => {
    expect(call({ code: 'K162', currentSize: 'medium', classA: 'C1', classB: 'HS' })).toBeNull();
    // the frigate-hole case: E004 into a C1 is destroyer-sized, so a scout who
    // set small must keep small -- the cap rules out bigger, it does not assign.
    expect(call({ code: 'K162', currentSize: 'small', classA: 'C1', classB: 'HS' })).toBeNull();
  });

  it('leaves a K162 with no C1 at either end alone', () => {
    expect(call({ code: 'K162', currentSize: 'large', classA: 'C5', classB: 'HS' })).toBeNull();
  });

  it('still trusts a known code, held under the cap', () => {
    expect(call({ code: 'N110', currentSize: 'large', classA: 'HS', classB: 'C5' })).toBe('medium');
    expect(call({ code: 'B274', currentSize: null, classA: 'HS', classB: 'C5' })).toBe('large');
    // a charted code that somehow claims large into a C1 is still capped
    expect(call({ code: 'B274', currentSize: null, classA: 'C1', classB: 'HS' })).toBe('medium');
  });

  it('does nothing while the type table is still loading', () => {
    expect(inferredSize({ code: 'N110', whTypes: {}, currentSize: 'large',
      classA: 'HS', classB: 'C5' })).toBeNull();
  });

  it('does not confuse C13 or C12 with C1', () => {
    expect(call({ code: 'K162', currentSize: 'large', classA: 'C13', classB: 'HS' })).toBeNull();
    expect(call({ code: 'K162', currentSize: 'large', classA: 'C12', classB: 'HS' })).toBeNull();
  });
});
