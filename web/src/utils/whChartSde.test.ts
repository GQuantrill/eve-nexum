import { describe, it, expect } from 'vitest';
import { shipSizeFromSde, totalMassFromSde, lifetimeFromSde } from './whChartSde';

// The wormhole type chart showed K329 as "up to Battleship" with 3,000M total.
// It takes 2,000M a jump (5,000M total), which is what lets a capital into a
// C4. The chart now reads all three columns from the SDE, not just ship size.
const live = {
  K329: { maxJumpMass: 2_000_000_000, totalMass: 5_000_000_000, lifetimeHours: 16 },
  E004: { maxJumpMass: 5_000_000, totalMass: 500_000_000, lifetimeHours: 4.5 },
};

describe('wormhole chart values from the SDE', () => {
  it('shows K329 as capital-sized with its real total mass', () => {
    expect(shipSizeFromSde('K329', live)).toBe('up to Capital');
    expect(totalMassFromSde('K329', live)).toBe('5 000 000 000 kg');
    expect(lifetimeFromSde('k329', live)).toBe('16h');
  });

  it("keeps a frigate hole's half hour", () => {
    expect(lifetimeFromSde('E004', live)).toBe('4.5h');
  });

  it("falls back when the SDE has nothing, or a value the column doesn't list", () => {
    expect(totalMassFromSde('X877', live)).toBeNull();
    expect(lifetimeFromSde('X877', live)).toBeNull();
    // A value with no row in the column (after a rebalance, say) has nowhere to draw to.
    expect(totalMassFromSde('Q999', { Q999: { totalMass: 1_234_000_000 } })).toBeNull();
    expect(lifetimeFromSde('Q999', { Q999: { lifetimeHours: 7 } })).toBeNull();
  });
});
