import { describe, it, expect } from 'vitest';
import { tagsFor, attackerTypeIds, specialKinds } from './killTags.js';

// A few SDE groups: HIC 894, interdictor 541, smartbomb 72, and a plain cruiser.
const GROUPS: Record<number, number> = { 11995: 894, 22456: 541, 3937: 72, 620: 26 };
const groupOf = (id: number) => GROUPS[id];

describe('tagsFor', () => {
  it('tags a kill on a stargate', () => {
    expect(tagsFor({ locationId: 50001249, typeIds: [] }, groupOf)).toEqual(['gate']);
    // A station (60M+) or a planet/moon (40M+) is not a gate.
    expect(tagsFor({ locationId: 60003760, typeIds: [] }, groupOf)).toEqual([]);
    expect(tagsFor({ locationId: 40433252, typeIds: [] }, groupOf)).toEqual([]);
    expect(tagsFor({ locationId: null, typeIds: [] }, groupOf)).toEqual([]);
  });

  it('tags HICs, interdictors and smartbombs from the attackers', () => {
    expect(tagsFor({ typeIds: [11995, 620] }, groupOf)).toEqual(['hic']);
    expect(tagsFor({ typeIds: [22456] }, groupOf)).toEqual(['dic']);
    expect(tagsFor({ typeIds: [620, 3937] }, groupOf)).toEqual(['sb']);
  });

  it("keeps a fixed order, with zKillboard's verdicts after the ship tags", () => {
    expect(tagsFor({ locationId: 50000001, solo: true, npc: true, labels: ['ganked', 'awox', 'padding'], typeIds: [3937, 22456, 11995] }, groupOf))
      .toEqual(['gate', 'hic', 'dic', 'sb', 'solo', 'ganked', 'awox', 'padding', 'npc']);
  });

  it("reads zKillboard's labels, and only the ones it knows", () => {
    expect(tagsFor({ labels: ['tz:eu', 'cat:6', '#:1', 'pvp', 'loc:highsec', 'solo'], typeIds: [] }, groupOf)).toEqual(['solo']);
    expect(tagsFor({ labels: ['ganked', 'pvp'], typeIds: [] }, groupOf)).toEqual(['ganked']);
    expect(tagsFor({ labels: ['a:awox', 'awox'], typeIds: [] }, groupOf)).toEqual(['awox']);
    expect(tagsFor({ awox: true, typeIds: [] }, groupOf)).toEqual(['awox']);
    expect(tagsFor({ labels: 'ganked', typeIds: [] }, groupOf)).toEqual([]);
    expect(tagsFor({ labels: [42, null, '<b>x</b>'], typeIds: [] }, groupOf)).toEqual([]);
  });

  it('ignores types it does not know', () => {
    expect(tagsFor({ typeIds: [999999] }, groupOf)).toEqual([]);
  });
});

describe('attackerTypeIds', () => {
  it('collects ship and weapon types once each, skipping blanks', () => {
    expect(attackerTypeIds([
      { ship_type_id: 11995, weapon_type_id: 3937 },
      { ship_type_id: 11995 },
      { weapon_type_id: 0 },
    ]).sort()).toEqual([11995, 3937].sort());
    expect(attackerTypeIds(undefined)).toEqual([]);
  });
});

describe('specialKinds', () => {
  // Victim hulls: a dreadnought (485), a frigate (25) and a capsule.
  const VICTIMS: Record<number, number> = { 19720: 485, 587: 25, 670: 29 };
  const victimGroup = (id: number) => VICTIMS[id];

  it('flags capitals and billion-ISK kills', () => {
    expect(specialKinds({ shipTypeId: 19720, totalValue: 3e9 }, victimGroup)).toEqual(['capital', 'billion']);
    expect(specialKinds({ shipTypeId: 587, totalValue: 1e9 }, victimGroup)).toEqual(['billion']);
    expect(specialKinds({ shipTypeId: 587, totalValue: 999e6 }, victimGroup)).toEqual([]);
  });

  it('flags dictor, HIC and smartbomb kills, but not pods', () => {
    expect(specialKinds({ shipTypeId: 587, totalValue: 2e6, tags: ['gate', 'dic'] }, victimGroup)).toEqual(['dictor']);
    expect(specialKinds({ shipTypeId: 587, totalValue: 2e6, tags: ['hic', 'sb'] }, victimGroup)).toEqual(['dictor', 'smartbomb']);
    expect(specialKinds({ shipTypeId: 670, totalValue: 1e5, tags: ['dic', 'sb'] }, victimGroup)).toEqual([]);
  });

  it('treats an unknown hull as not a capital', () => {
    expect(specialKinds({ shipTypeId: 123, totalValue: 0, tags: ['solo'] }, victimGroup)).toEqual([]);
  });
});
