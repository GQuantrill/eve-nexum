import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { appLimiter, publicLimiter, authLimiter } from './rateLimits.js';

// Stand in for express-session: whatever userId the request asks for.
function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.set('trust proxy', 2);
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    if (id) (req as unknown as { session: { userId: number } }).session = { userId: Number(id) };
    next();
  });
  app.use(limiter);
  app.get('/', (_req, res) => { res.json({ ok: true }); });
  return app;
}

const remaining = (res: request.Response) =>
  Number(/remaining=(\d+)/.exec(res.headers['ratelimit'] ?? '')?.[1] ?? NaN);

describe('rate limit keying', () => {
  it('gives two users their own budget from the same IP', async () => {
    // The bug: everyone behind one proxy shared a bucket, so one busy user
    // rate-limited the whole instance.
    const app = appWith(appLimiter);
    const a1 = await request(app).get('/').set('x-test-user', '101');
    const a2 = await request(app).get('/').set('x-test-user', '101');
    const b1 = await request(app).get('/').set('x-test-user', '202');
    expect(remaining(a2)).toBe(remaining(a1) - 1);   // same user counts down
    expect(remaining(b1)).toBe(remaining(a1));       // other user unaffected
  });

  it('separates one user from another even across different IPs', async () => {
    const app = appWith(appLimiter);
    const first  = await request(app).get('/').set('x-test-user', '303').set('x-forwarded-for', '1.2.3.4, 10.0.0.1');
    const second = await request(app).get('/').set('x-test-user', '303').set('x-forwarded-for', '5.6.7.8, 10.0.0.1');
    expect(remaining(second)).toBe(remaining(first) - 1);   // follows the user
  });

  it('falls back to the client IP when there is no session', async () => {
    const app = appWith(appLimiter);
    const a = await request(app).get('/').set('x-forwarded-for', '9.9.9.9, 10.0.0.1');
    const b = await request(app).get('/').set('x-forwarded-for', '8.8.8.8, 10.0.0.1');
    expect(remaining(b)).toBe(remaining(a));   // different clients, separate budgets
  });

  it('keeps the public limiter keyed on IP', async () => {
    const app = appWith(publicLimiter);
    const a = await request(app).get('/').set('x-forwarded-for', '9.9.9.9, 10.0.0.1');
    const b = await request(app).get('/').set('x-forwarded-for', '8.8.8.8, 10.0.0.1');
    expect(remaining(b)).toBe(remaining(a));
  });

  it('keeps the SSO limiter on IP even for a logged-in caller', async () => {
    // It guards brute-force, where the caller has no session by definition;
    // keying it per user would weaken that.
    const app = appWith(authLimiter);
    const a = await request(app).get('/').set('x-test-user', '404').set('x-forwarded-for', '7.7.7.7, 10.0.0.1');
    const b = await request(app).get('/').set('x-test-user', '505').set('x-forwarded-for', '7.7.7.7, 10.0.0.1');
    expect(remaining(b)).toBe(remaining(a) - 1);   // same IP, one budget
  });
});
