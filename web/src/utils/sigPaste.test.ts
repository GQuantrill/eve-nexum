import { describe, it, expect } from 'vitest';
import { parseSigClipboard, pasteUpdatesFor } from './sigPaste';
import type { Signature } from '../types';

// Asked by a pilot: they scanned 48 sigs, marked the holes as wormholes by hand,
// disconnected, and now the scanner shows them as bare "Cosmic Signature"
// again. Will re-pasting with overwrite on reset them all? It must not.

const row = (...cols: string[]) => cols.join('\t');

const markedHole: Signature = {
  id: 'r1', sigId: 'ABC-123', sigType: 'wormhole', name: '', notes: 'bm down',
  whType: 'B274', whLeadsTo: 'HS', ghostType: '', massStatus: 'destabilized', timeStatus: 'eol',
  createdAt: '2026-10-28T20:00:00Z', updatedAt: '2026-10-28T20:00:00Z',
};

describe('re-pasting over sigs typed by hand', () => {
  it('reads an unscanned row as no type and no name', () => {
    const [p] = parseSigClipboard(row('ABC-123', 'Cosmic Signature', '', '', '0.0%', '4.2 AU'));
    expect(p).toMatchObject({ sigId: 'ABC-123', sigType: 'unknown', name: '', whLeadsTo: '' });
  });

  it('leaves a hand-marked wormhole exactly as it was', () => {
    const [p] = parseSigClipboard(row('ABC-123', 'Cosmic Signature', '', '', '0.0%', '4.2 AU'));
    expect(pasteUpdatesFor(markedHole, p)).toEqual({});
  });

  it('leaves its hole type, leads-to, mass and life alone when the scan agrees', () => {
    const [p] = parseSigClipboard(row('ABC-123', 'Cosmic Signature', 'Wormhole', 'Unstable Wormhole', '100.0%', '4.2 AU'));
    expect(pasteUpdatesFor(markedHole, p)).toEqual({ sigType: 'wormhole', name: 'Unstable Wormhole' });
  });

  it('still takes a type the scanner now knows', () => {
    const unknown: Signature = { ...markedHole, sigType: 'unknown', whType: '', whLeadsTo: '' };
    const [p] = parseSigClipboard(row('ABC-123', 'Cosmic Signature', 'Data Site', 'Unsecured Frontier Server', '100.0%', '4.2 AU'));
    expect(pasteUpdatesFor(unknown, p)).toEqual({ sigType: 'data', name: 'Unsecured Frontier Server' });
  });

  it('keeps cosmic anomalies out of the signature list', () => {
    expect(parseSigClipboard(row('XYZ-789', 'Cosmic Anomaly', 'Combat Site', 'Perimeter Ambush Point', '100.0%', '2 AU'))).toEqual([]);
  });
});
