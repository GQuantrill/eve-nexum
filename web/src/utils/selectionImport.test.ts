import { describe, it, expect } from 'vitest';
import { readTable, checkRows, planImport, splitTable, type KnownSystem } from './selectionImport';
import { exportRows, toDelimited, type Clip } from './selectionExport';

const known = new Map<string, KnownSystem>([
  ['j100001', { eveSystemId: 31000101, name: 'J100001' }],
  ['j100002', { eveSystemId: 31000102, name: 'J100002' }],
  ['j100003', { eveSystemId: 31000103, name: 'J100003' }],
]);
const whTypes = { D382: { maxJumpMass: 375_000_000, lifetimeHours: 16 }, H296: { maxJumpMass: 1_000_000_000, lifetimeHours: 24 } };

const check = (csv: string) => checkRows(readTable(csv)!, known, whTypes);

describe('reading an import table', () => {
  it('splits quoted CSV and picks the separator from the header', () => {
    expect(splitTable('a,"b,c","d ""e"""\r\n1,2,3\n', ',')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    expect(readTable('Group;System\nA;J100001')![0].cells.system).toBe('J100001');
    expect(readTable('group\tsystem\tmass\nA\tJ100001\t50')![0].cells['mass-remaining']).toBe('50');
    expect(readTable('name,signature\nx,ABC-123')).toBeNull();
  });
});

describe('checking rows against the rules', () => {
  it('accepts a full wormhole row and fills the K162 side', () => {
    const [r] = check('system,signature,to-system,from-type,mass-remaining,life-remaining\nj100001,abc123,J100002,D382,50,4');
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({
      system: 'J100001', signature: 'ABC-123', sigType: 'wormhole', toSystem: 'J100002',
      fromType: 'D382', toType: 'K162', size: 'large', mass: 'destabilized', life: 'lessThan4h', lifeHours: 4,
    });
  });

  it('defaults mass to over 50% and life to the type maximum', () => {
    const [r] = check('system,signature,from-type\nJ100001,ABC-123,D382');
    expect(r).toMatchObject({ mass: 'stable', life: 'lessThan24h', lifeHours: null });
  });

  it('flags each broken rule', () => {
    const rows = check([
      'system,signature,sig-type,to-system,from-type,to-type,size,mass-remaining,life-remaining',
      'Nowhere,ABC-123,,,,,,,',              // unknown system
      'J100001,ABC-123,data,J100002,,,,,',   // hole fields on a data site
      'J100001,ABC-123,,,K162,K162,,,',      // both ends K162
      'J100001,ABC-123,,,D382,,xl,,',        // a D382 is not XL
      'J100001,ABC-123,,J100001,,,,,',       // a hole to itself
      'J100001,AB-12,,,,,,,',                // bad signature
      'J100001,ABC-123,,,,,,75,',            // mass must be 100, 50 or 10
      'J100001,ABC-123,,,,,,,12',            // life must be 48, 24, 4, 1 or 0
      'J100001,ABC-123,,,Q999,,,,',          // not a wormhole type
    ].join('\n'));
    expect(rows.map((r) => r.errors)).toEqual([
      ['unknownSystem'], ['whOnly'], ['bothK162'], ['sizeMismatch'], ['sameSystem'],
      ['badSignature'], ['badMass'], ['badLife'], ['badType'],
    ]);
  });
});

describe('turning rows into a paste', () => {
  const rows = check([
    'group,system,signature,to-system,from-type',
    'Alpha,J100001,ABC-123,J100002,D382',
    'Alpha,J100002,XYZ-999,J100001,',
    'Alpha,J100002,DEF-456,J100003,H296',
    'Beta,J100003,GAS-001,,',
    'Bad,Nowhere,ABC-123,,',
  ].join('\n'));

  it('links both ends of a hole to their signatures and skips bad rows', () => {
    const plan = planImport(rows, known, 'map', 0);
    const clip = plan.clip as { systems: { id: string }[]; connections: Record<string, unknown>[]; signatures: { id: string }[] };
    expect(clip.systems).toHaveLength(3);
    expect(clip.connections).toHaveLength(2);
    expect(clip.connections[0]).toMatchObject({ sourceSignatureId: 'g2', targetSignatureId: 'g3', type: 'D382' });
    expect(clip.signatures).toHaveLength(4);
    expect(plan.chains).toEqual([]);
    expect(plan.mergeLabels).toBe(false);
  });

  it('saves a group as a chain when it is one path, and says when it is not', () => {
    const plan = planImport(rows, known, 'chain', 0);
    expect(plan.chains).toEqual([{ name: 'Alpha', systemIds: ['s31000101', 's31000102', 's31000103'] }]);
    expect(plan.notPaths).toEqual(['Beta']);
  });

  it('labels the group systems', () => {
    const plan = planImport(rows, known, 'label', 0);
    const sys = (plan.clip as { systems: { id: string; customLabels: string[] }[] }).systems;
    expect(sys.find((s) => s.id === 's31000103')!.customLabels).toEqual(['t:Alpha', 't:Beta']);
    expect(plan.mergeLabels).toBe(true);
  });
});

describe('export then import', () => {
  it('reads back what Export systems writes', () => {
    const clip: Clip = {
      name: 'Home', chains: [{ name: 'Static', systemIds: ['a', 'b'] }],
      systems: [{ id: 'a', name: 'J100001', customLabels: ['t:#ff0000:Hot'] }, { id: 'b', name: 'J100002' }],
      signatures: [{ id: 'g1', systemId: 'a', sigId: 'ABC-123', sigType: 'wormhole', name: '', whType: 'D382' }],
      connections: [{ sourceId: 'a', targetId: 'b', size: 'large', massStatus: 'stable', timeStatus: 'fresh',
        sourceSignatureId: 'g1', targetSignatureId: null }],
    };
    expect(exportRows(clip, false, 'chain').map((r) => r.group)).toEqual(['Static', 'Static']);
    expect(exportRows(clip, false, 'label')[0].group).toBe('Hot');
    const back = check(toDelimited(exportRows(clip, false), ','));
    expect(back.every((r) => r.errors.length === 0)).toBe(true);
    expect(back[0]).toMatchObject({ toSystem: 'J100002', fromType: 'D382', toType: 'K162', mass: 'stable', life: 'lessThan24h', lifeHours: 16 });
  });
});
