import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freezeCheck } from './freezeDetector.js';

let t = 0;
let warn: ReturnType<typeof vi.spyOn>;
const logged = () => warn.mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  t = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('freezeCheck', () => {
  it('stays quiet when ticks arrive on time', () => {
    const tick = freezeCheck(() => t);
    for (let i = 0; i < 5; i++) { t += 505; tick(); }
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs how long the server was frozen', () => {
    const tick = freezeCheck(() => t);
    t += 500 + 125_000;
    tick();
    expect(logged()).toContain('server froze for 125000ms');
  });

  it('ignores a delay under a second', () => {
    const tick = freezeCheck(() => t);
    t += 500 + 900;
    tick();
    expect(warn).not.toHaveBeenCalled();
  });
});
