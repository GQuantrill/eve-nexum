import { describe, it, expect } from 'vitest';
import { exportRows, toDelimited, toJson, type Clip } from './selectionExport';

const clip: Clip = {
  name: 'Home chain',
  systems: [
    { id: 'a', name: 'J100001' },
    { id: 'b', name: 'J100002', locked: true },
    { id: 'c', name: 'Amarr' },
  ],
  signatures: [
    { id: 'g1', systemId: 'a', sigId: 'ABC-123', sigType: 'wormhole', name: '', whType: 'D382' },
    { id: 'g2', systemId: 'b', sigId: 'XYZ-999', sigType: 'wormhole', name: '', whType: 'K162' },
    { id: 'g3', systemId: 'a', sigId: 'GAS-001', sigType: 'gas', name: '=HYPERLINK("x")', whType: '' },
  ],
  connections: [
    { sourceId: 'a', targetId: 'b', size: 'large', massStatus: 'destabilized', timeStatus: 'eol',
      sourceSignatureId: 'g1', targetSignatureId: 'g2' },
  ],
};

describe('exporting selected systems', () => {
  it('one row per signature, wormhole details from the link it backs', () => {
    const rows = exportRows(clip, false);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      group: 'Home chain', system: 'J100001', signature: 'ABC-123', 'sig-type': 'wormhole',
      'to-system': 'J100002', 'from-type': 'D382', 'to-type': 'K162', size: 'large',
      'mass-remaining': '50', 'life-remaining': '4',
    });
    // Not a wormhole: no hole fields.
    expect(rows[1]).toMatchObject({ signature: 'GAS-001', 'to-system': '', size: '' });
    // A system with no signatures still gets a row.
    expect(rows[3]).toMatchObject({ system: 'Amarr', signature: '' });
  });

  it('can leave locked systems out', () => {
    expect(exportRows(clip, true).map((r) => r.system)).toEqual(['J100001', 'J100001', 'Amarr']);
  });

  it('writes CSV and TSV a spreadsheet will not run as formulas', () => {
    const rows = exportRows(clip, true);
    const csv = toDelimited(rows, ',');
    expect(csv.split('\r\n')[0]).toBe('group,system,signature,sig-type,name,to-system,from-type,to-type,size,mass-remaining,life-remaining');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const tsv = toDelimited(rows, '\t');
    expect(tsv.split('\r\n')[2].split('\t')[4]).toBe(`'=HYPERLINK("x")`);
    expect(JSON.parse(toJson(rows))).toHaveLength(3);
  });
});
