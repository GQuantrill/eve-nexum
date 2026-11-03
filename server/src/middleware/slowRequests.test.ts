import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { slowRequests } from './slowRequests.js';

// performance.now is stubbed to jump forward by `elapsed` between the
// middleware's start and the response, so no test actually waits.
let elapsed = 0;
let warn: ReturnType<typeof vi.spyOn>;

function app() {
  const a = express();
  a.use(slowRequests);
  a.get('/api/maps/:id', (_req, res) => { clock.advance(); res.json({ ok: true }); });
  a.get('/api/share/:token', (_req, res) => { clock.advance(); res.json({ ok: true }); });
  a.get('/api/maps/:id/events', (_req, res) => { clock.advance(); res.json({ ok: true }); });
  return a;
}
const clock = { t: 0, advance() { this.t += elapsed; } };
const logged = () => warn.mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  clock.t = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('slowRequests', () => {
  it('stays quiet for a normal request', async () => {
    elapsed = 40;
    await request(app()).get('/api/maps/abc').expect(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a slow one with method, path, status and time', async () => {
    elapsed = 5_000;
    await request(app()).get('/api/maps/abc').expect(200);
    expect(logged()).toContain('slow request GET /api/maps/abc -> 200 in 5000ms');
  });

  it('never writes the query string or a share token', async () => {
    elapsed = 5_000;
    await request(app()).get('/api/maps/abc?code=SECRET').expect(200);
    await request(app()).get('/api/share/tok3n-SECRET').expect(200);
    expect(logged()).not.toContain('SECRET');
    expect(logged()).toContain('/api/share/:token');
  });

  it('skips live-update streams', async () => {
    elapsed = 60_000;
    await request(app()).get('/api/maps/abc/events').expect(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
