import { describe, it, expect } from 'vitest';
import { tagsFor, attackerTypeIds } from './killTags.js';

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

  it('keeps a fixed order, with solo and npc last', () => {
    expect(tagsFor({ locationId: 50000001, solo: true, npc: true, typeIds: [3937, 22456, 11995] }, groupOf))
      .toEqual(['gate', 'hic', 'dic', 'sb', 'solo', 'npc']);
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
