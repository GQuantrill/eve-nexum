import { describe, it, expect } from 'vitest';
import { heatScale } from './heatmap';

describe('heatScale', () => {
  it("doesn't let one quiet system be the full-red reference", () => {
    // The report: the only k-space system on a wormhole map, one kill, full red.
    expect(1 / heatScale('shipKills', 1)).toBe(0.1);
    expect(heatScale('npcKills', 30)).toBe(200);
  });

  it("uses the busiest system once it's past the floor", () => {
    expect(heatScale('shipKills', 40)).toBe(40);
    expect(heatScale('jumps', 350)).toBe(350);
  });

  it('is off with no metric', () => {
    expect(heatScale('none', 12)).toBe(0);
  });
});
