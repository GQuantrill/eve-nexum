import { describe, it, expect } from 'vitest';
import { parseMapBackup, BackupError, MAX_BACKUP_SYSTEMS } from './mapBackup.js';

const NOW = Date.UTC(2026, 9, 28, 3, 0);
const sys = (over: Record<string, unknown> = {}) => ({ id: 's1', eveSystemId: 31000005, name: 'J123456', position: { x: 10, y: 20 }, ...over });

describe('parseMapBackup', () => {
  it("refuses something that isn't a map", () => {
    expect(() => parseMapBackup(null)).toThrow(BackupError);
    expect(() => parseMapBackup({ systems: [] })).toThrow(BackupError);
    expect(() => parseMapBackup('nope')).toThrow(BackupError);
  });

  it('refuses a file over the limits with a 413', () => {
    const systems = Array.from({ length: MAX_BACKUP_SYSTEMS + 1 }, (_, i) => sys({ id: `s${i}` }));
    try {
      parseMapBackup({ systems, connections: [] });
      throw new Error('expected a BackupError');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupError);
      expect((err as BackupError).status).toBe(413);
    }
  });

  it('keeps the fields that make a chain worth restoring', () => {
    const b = parseMapBackup({
      name: 'Home chain',
      settings: { lazyRemoveWormholes: true, collapseGraceHours: 2, bookmarkFormat: ' {sig} ', siteBookmarkFormat: '' },
      systems: [sys({ notes: 'rage rolled', labels: ['a', 'zz'], customLabels: ['t:#ff0000:HOME'], intel: 'hostile', tag: 'H', alias: 'Home' })],
      connections: [{
        id: 'c1', sourceId: 's1', targetId: 's2', type: 'h296', connectionType: 'standard',
        massStatus: 'destabilized', timeStatus: 'eol', size: 'xl', massUsed: 1.5e9,
        eolAt: '2026-10-28T01:00:00Z', lifetimeExpiresAt: '2026-10-28T05:00:00Z',
        broken: false, flagIcon: 'Skull', flagNote: 'bubbled', flagBlink: true, flagColor: '#ff8800',
        sourceSignatureId: 'g1', targetSignatureId: null,
      }],
      signatures: [{ id: 'g1', systemId: 's1', sigId: 'abc-123', sigType: 'wormhole', whType: 'h296', createdAt: '2026-10-27T20:00:00Z' }],
      anomalies: [{ systemId: 's1', anomId: 'xyz-987', anomType: 'combat', name: 'Perimeter Ambush Point' }],
      structures: [{ systemId: 's1', name: 'Fort', structureType: 'Astrahus', eveId: '1035466617946', ownerCorpId: 98000001 }],
    }, NOW);

    expect(b.name).toBe('Home chain');
    expect(b.settings).toEqual({ lazyRemoveWormholes: true, collapseGraceHours: 2, bookmarkFormat: '{sig}', siteBookmarkFormat: null });
    expect(b.systems[0]).toMatchObject({ notes: 'rage rolled', labels: ['a'], customLabels: ['t:#ff0000:HOME'], intel: 'hostile', tag: 'H', alias: 'Home' });
    expect(b.connections[0]).toMatchObject({
      type: 'H296', massStatus: 'destabilized', timeStatus: 'eol', size: 'xl', massUsed: 1.5e9,
      eolAt: '2026-10-28T01:00:00.000Z', lifetimeExpiresAt: '2026-10-28T05:00:00.000Z',
      flagIcon: 'Skull', flagNote: 'bubbled', flagBlink: true, flagColor: '#ff8800', sourceSignatureId: 'g1',
    });
    expect(b.signatures[0]).toMatchObject({ sigId: 'ABC-123', whType: 'H296', createdAt: '2026-10-27T20:00:00.000Z' });
    expect(b.anomalies[0]).toMatchObject({ anomId: 'XYZ-987', anomType: 'combat' });
    expect(b.structures[0]).toMatchObject({ eveId: '1035466617946', ownerCorpId: 98000001 });
  });

  it('drops or resets anything it should not trust', () => {
    const b = parseMapBackup({
      systems: [sys({
        systemClass: 'C99', effect: '<script>', status: 'pwned', statics: ['C247', 'x;drop', 'C247'],
        labels: ['a', 'a'], customLabels: ['x:bad', 't:ok', 't:2', 't:3', 't:4'], intel: 'no spaces allowed',
        tag: 'TOO', notes: 'n'.repeat(30_000), position: { x: Infinity, y: 9e9 },
      })],
      connections: [{
        id: 'c1', sourceId: 's1', targetId: 's2', type: 'bad type!', connectionType: 'teleporter',
        massStatus: 'gone', timeStatus: 'soon', size: 'huge', massUsed: -5,
        eolAt: '2099-01-01T00:00:00Z', lifetimeExpiresAt: '2099-01-01T00:00:00Z',
        flagColor: 'red;background:url(x)', flagNote: 'n'.repeat(500), broken: true,
      }],
      signatures: [{ id: 'g1', systemId: 's1', sigId: 'NOT A SIG', sigType: 'treasure', notes: 'n'.repeat(5_000) }],
    }, NOW);

    const s = b.systems[0];
    expect(s).toMatchObject({ effect: 'none', status: 'unknown', statics: ['C247'], labels: ['a'], intel: null, tag: null });
    expect(s.customLabels).toEqual(['t:ok', 't:2', 't:3']);
    expect(s.notes).toHaveLength(20_000);
    expect(s.position).toEqual({ x: 0, y: 1e6 });

    const c = b.connections[0];
    expect(c).toMatchObject({ type: null, connectionType: 'standard', massStatus: null, timeStatus: null, size: 'large', massUsed: 0, flagColor: null, flagNote: null });
    // Nothing from the future: an EOL stamp after now is clamped, a lifetime end far ahead dropped.
    expect(c.eolAt).toBe(new Date(NOW).toISOString());
    expect(c.lifetimeExpiresAt).toBeNull();
    // A broken line always gets a stamp, so the removal sweep can see it.
    expect(c.brokenAt).toBe(new Date(NOW).toISOString());

    expect(b.signatures[0]).toMatchObject({ sigId: '', sigType: 'unknown' });
    expect(b.signatures[0].notes).toHaveLength(2_000);
  });

  it('reads the older export, which was the raw map state', () => {
    const b = parseMapBackup({
      id: 'old', name: 'Legacy', isCorpMap: true, shareToken: 'secret', lazyRemoveWormholes: true, collapseGraceHours: 3,
      systems: [sys()], connections: [], routes: [{ id: 'r1' }],
    }, NOW);
    expect(b.settings).toMatchObject({ lazyRemoveWormholes: true, collapseGraceHours: 3 });
    expect(b.signatures).toEqual([]);
    // Scope and share token are not part of what's parsed.
    expect(JSON.stringify(b)).not.toContain('secret');
  });
});
