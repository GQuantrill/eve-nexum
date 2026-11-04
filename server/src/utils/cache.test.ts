import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { TtlValue, cachedJsonHandler, RETRY_AFTER_FAIL_MS } from './cache.js';

const log = { error: vi.fn() };
const opts = { log, logMsg: 'failed:', errorMsg: 'Failed' };

function call(handler: ReturnType<typeof cachedJsonHandler>) {
  const res = { statusCode: 200, body: undefined as unknown } as Response & { body: unknown };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return handler({} as Request, res).then(() => res);
}

beforeEach(() => { vi.useFakeTimers(); log.error.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('cachedJsonHandler', () => {
  it('waits before retrying a failed upstream, serving stale meanwhile', async () => {
    const cache = new TtlValue<string>(1_000);
    cache.set('old');
    vi.advanceTimersByTime(2_000);
    const build = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const h = cachedJsonHandler(cache, build, opts);

    expect((await call(h)).body).toBe('old');
    expect((await call(h)).body).toBe('old');
    expect(build).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RETRY_AFTER_FAIL_MS);
    build.mockResolvedValue('new');
    expect((await call(h)).body).toBe('new');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('answers 502 during the wait when nothing is cached', async () => {
    const build = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const h = cachedJsonHandler(new TtlValue<string>(1_000), build, opts);
    expect((await call(h)).statusCode).toBe(502);
    expect((await call(h)).statusCode).toBe(502);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
