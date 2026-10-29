import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// data/wormholes.json is the curated fallback for hole types the SDE doesn't
// carry, and the source of `src`. Its mass columns were once shifted by a field
// for almost every hole: max_mass_per_jump held the TOTAL mass, and total_mass
// held the lifetime in MINUTES (A239: "max" 2,000,000,000, "total" 1440). The
// values now come from CCP's live dogma (ESI /universe/types), NOT from
// anoik.is, which is out of date for some holes. These checks catch the shifted
// shape coming back.

interface Spec {
  dest: string | null;
  max_mass_per_jump: number | null;
  total_mass: number | null;
  lifetime: number | null;
  src: string[] | null;
}

const data = JSON.parse(
  readFileSync(join(__dirname, '../../data/wormholes.json'), 'utf8'),
) as Record<string, Spec>;

const holes = Object.entries(data).filter(([code]) => code !== 'K162');

describe('curated wormhole data', () => {
  it('never lets one jump exceed the whole hole', () => {
    for (const [code, s] of holes) {
      if (s.max_mass_per_jump == null || s.total_mass == null) continue;
      expect(s.max_mass_per_jump, code).toBeLessThanOrEqual(s.total_mass);
    }
  });

  it('holds total mass in kg, not a lifetime in minutes', () => {
    for (const [code, s] of holes) {
      if (s.total_mass == null) continue;
      expect(s.total_mass, code).toBeGreaterThanOrEqual(1_000_000);
    }
  });

  it('holds lifetimes in hours', () => {
    for (const [code, s] of holes) {
      if (!s.lifetime) continue;
      expect(s.lifetime, code).toBeLessThanOrEqual(48);
    }
  });

  it('caps every hole leading into a C1-C4 at battleship size', () => {
    // Every hole that LEADS INTO a C1-C4 is battleship-sized at most.
    for (const [code, s] of holes) {
      if (!['c1', 'c2', 'c3', 'c4'].includes(s.dest ?? '') || s.max_mass_per_jump == null) continue;
      expect(s.max_mass_per_jump, code).toBeLessThanOrEqual(375_000_000);
    }
  });

  it('lets no capital into a C1-C4 by any hole', () => {
    // Not by a hole leading in (above), and not by the K162 of one that opens
    // inside: nothing that appears in a C1-C4 takes a ship over 1,000M kg.
    for (const [code, s] of holes) {
      const src = s.src ?? [];
      if (!src.some((c) => ['c1', 'c2', 'c3', 'c4'].includes(c)) || s.max_mass_per_jump == null) continue;
      expect(s.max_mass_per_jump, code).toBeLessThan(1_000_000_000);
    }
  });

  it("matches CCP on K329, which anoik.is lists as capital-sized", () => {
    // anoik.is shows K329 at 2,000M a jump / 5,000M total; CCP's live dogma
    // (ESI type 30697) says 375M / 3,000M. CCP's is what the game enforces.
    expect(data.K329).toMatchObject({ dest: 'ns', max_mass_per_jump: 375_000_000, total_mass: 3_000_000_000 });
    expect(data.N290).toMatchObject({ dest: 'ls', max_mass_per_jump: 375_000_000, total_mass: 3_000_000_000 });
  });
});
