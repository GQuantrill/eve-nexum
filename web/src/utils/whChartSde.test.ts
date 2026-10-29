import { describe, it, expect } from 'vitest';
import { shipSizeFromSde, totalMassFromSde, lifetimeFromSde } from './whChartSde';

// The chart reads ship size, total mass and lifetime from the SDE, so its
// bundled table can't leave it wrong. C248 (C6 -> null) is a capital hole:
// 2,000M a jump, 3,300M total, 16 h, per CCP's dogma.
const live = {
  C248: { maxJumpMass: 2_000_000_000, totalMass: 3_300_000_000, lifetimeHours: 16 },
  E004: { maxJumpMass: 5_000_000, totalMass: 500_000_000, lifetimeHours: 4.5 },
};

describe('wormhole chart values from the SDE', () => {
  it("shows a capital hole's size, total mass and lifetime", () => {
    expect(shipSizeFromSde('C248', live)).toBe('up to Capital');
    expect(totalMassFromSde('C248', live)).toBe('3 300 000 000 kg');
    expect(lifetimeFromSde('c248', live)).toBe('16h');
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
