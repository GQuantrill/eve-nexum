import { describe, it, expect } from 'vitest';
import { structureKind } from './structureKind';

describe('structureKind', () => {
  it('sorts hulls into their kind, faction variants included', () => {
    expect(structureKind('Astrahus', 'citadel')).toBe(true);
    expect(structureKind("'Moreau' Fortizar", 'citadel')).toBe(true);
    expect(structureKind('Upwell Palatine Keepstar', 'citadel')).toBe(true);
    expect(structureKind('Raitaru', 'engineering')).toBe(true);
    expect(structureKind('Tatara', 'refinery')).toBe(true);
    expect(structureKind('Tatara', 'citadel')).toBe(false);
  });

  it('all is anything you can dock at', () => {
    expect(structureKind('Sotiyo', 'all')).toBe(true);
    expect(structureKind('Ansiblex Jump Bridge', 'all')).toBe(false);
    expect(structureKind('Metenox Moon Drill', 'all')).toBe(false);
    expect(structureKind('', 'all')).toBe(false);
  });
});
