import { describe, it, expect, beforeEach } from 'vitest';
import { zkillPaused, noteZkillFailure, resetZkillPause, ZKILL_PAUSE_MS } from './zkill.js';

const err = (name: string) => Object.assign(new Error('x'), { name });

beforeEach(() => resetZkillPause());

describe('zKill pause', () => {
  it('is not paused to begin with', () => {
    expect(zkillPaused(1_000)).toBe(false);
  });

  it('pauses after a timeout, then lifts', () => {
    noteZkillFailure(err('TimeoutError'), 1_000);
    expect(zkillPaused(1_000 + ZKILL_PAUSE_MS - 1)).toBe(true);
    expect(zkillPaused(1_000 + ZKILL_PAUSE_MS)).toBe(false);
  });

  it('pauses after a network failure', () => {
    noteZkillFailure(new TypeError('fetch failed'), 1_000);
    expect(zkillPaused(2_000)).toBe(true);
  });

  it('does not pause for a bad response body', () => {
    noteZkillFailure(new SyntaxError('Unexpected token'), 1_000);
    expect(zkillPaused(2_000)).toBe(false);
  });
});
