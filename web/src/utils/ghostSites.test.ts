import { describe, it, expect } from 'vitest';
import { GHOST_SUFFIX, ghostTier } from './ghostSites';

describe('ghost site detection', () => {
  // The scanner's type column is unreliable for these — the name is the signal.
  it.each([
    'Superior Blood Raider Covert Research Facility',
    'Improved Guristas Covert Research Facility',
    'Lesser Sansha Covert Research Facility',
    'Serpentis Covert Research Facility',
  ])('recognises "%s" as a ghost site', (name) => {
    expect(GHOST_SUFFIX.test(name)).toBe(true);
  });

  it.each(['Abandoned Research Complex', 'Ruined Sansha Monument', ''])(
    'does not mistake "%s" for one', (name) => {
      expect(GHOST_SUFFIX.test(name)).toBe(false);
    });
});

describe('ghostTier', () => {
  it.each([
    ['Lesser Sansha Covert Research Facility',          'Lesser',   'ghostTier.hisec'],
    ['Serpentis Covert Research Facility',              'Standard', 'ghostTier.lowsec'],
    ['Improved Guristas Covert Research Facility',      'Improved', 'ghostTier.nullWh'],
    ['Superior Blood Raider Covert Research Facility',  'Superior', 'ghostTier.wh'],
  ])('reads %s as %s', (name, tier, space) => {
    expect(ghostTier('ghost', name)).toEqual({ tier, space });
  });

  // A tier word with no tier prefix falls back to Standard — the plain
  // "<Faction> Covert Research Facility" is the low-sec variant.
  it('treats an untiered facility as Standard', () => {
    expect(ghostTier('ghost', 'Angel Cartel Covert Research Facility')?.tier).toBe('Standard');
  });

  it('is case-insensitive about the tier word', () => {
    expect(ghostTier('ghost', 'IMPROVED Guristas Covert Research Facility')?.tier).toBe('Improved');
  });

  it('returns nothing for signatures that are not ghost sites', () => {
    expect(ghostTier('data', 'Superior Blood Raider Covert Research Facility')).toBeNull();
    expect(ghostTier('ghost', 'Ruined Sansha Monument')).toBeNull();
    expect(ghostTier('relic', 'Ruined Sansha Monument')).toBeNull();
  });
});
