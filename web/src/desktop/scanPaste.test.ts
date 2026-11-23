import { describe, it, expect } from 'vitest';
import { scanAllowed } from './scanPaste';

describe('scan paste: tracked character only', () => {
  const text = 'ABC-123\tCosmic Signature\tWormhole\t\t100.0%\t1 AU';
  it('takes every scan when the setting is off', () => {
    expect(scanAllowed({ text, character: 'Alt Pilot', trackedOnly: false }, 'Main Pilot')).toBe(true);
    expect(scanAllowed({ text }, 'Main Pilot')).toBe(true);
  });
  it('takes only the tracked character when on', () => {
    expect(scanAllowed({ text, character: 'Main Pilot', trackedOnly: true }, 'Main Pilot')).toBe(true);
    expect(scanAllowed({ text, character: 'main pilot', trackedOnly: true }, 'Main Pilot')).toBe(true);
    expect(scanAllowed({ text, character: 'Alt Pilot', trackedOnly: true }, 'Main Pilot')).toBe(false);
    expect(scanAllowed({ text, character: null, trackedOnly: true }, 'Main Pilot')).toBe(false);
  });
  it('does not block when no character is tracked yet', () => {
    expect(scanAllowed({ text, character: 'Alt Pilot', trackedOnly: true }, null)).toBe(true);
  });
});
