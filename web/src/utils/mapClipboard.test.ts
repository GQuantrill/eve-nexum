import { describe, it, expect } from 'vitest';
import { parseClip } from './mapClipboard';

describe('spotting copied systems on the clipboard', () => {
  it('takes a copy of systems', () => {
    const clip = { format: 'nexum-systems', systems: [{ id: 'a' }], connections: [] };
    expect(parseClip(` ${JSON.stringify(clip)}\n`)).toEqual(clip);
  });

  it('leaves everything else for the other paste handlers', () => {
    expect(parseClip('ABC-123\tCosmic Signature\tWormhole\t\t0.0%\t12.3 AU')).toBeNull();
    expect(parseClip('{"format":"nexum-map","systems":[]}')).toBeNull();
    expect(parseClip('{"format":"nexum-systems", broken')).toBeNull();
    expect(parseClip('{"format":"nexum-systems","systems":"no"}')).toBeNull();
  });
});
